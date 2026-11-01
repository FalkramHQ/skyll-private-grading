// FLKRM-382: AI student context must never fall back to unscoped reads, and a
// tutor session id is only honoured for its owner. Real SQLite fixtures.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { buildStudentContext } from '../../api/_lib/contextBuilder.js';
import { ownedSessionId, runTutorTurn } from '../../api/_lib/tutor.js';

let db;

const dna = (mode) => JSON.stringify({ primary_mode: { mode_id: mode } });

beforeEach(async () => {
  db = createClient({ url: ':memory:' });
  await db.batch([
    'CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT)',
    'CREATE TABLE students (id TEXT PRIMARY KEY, school_id TEXT, display_name TEXT)',
    'CREATE TABLE user_credentials (id TEXT PRIMARY KEY, user_id TEXT, login_id TEXT, status TEXT, is_primary INTEGER)',
    'CREATE TABLE student_user_links (student_id TEXT, user_id TEXT)',
    'CREATE TABLE student_enrollments (student_id TEXT, academic_year_id TEXT, standard TEXT, status TEXT, updated_at TEXT)',
    'CREATE TABLE academic_years (id TEXT, school_id TEXT, is_current INTEGER)',
    'CREATE TABLE learner_dna_v2 (student_id TEXT PRIMARY KEY, school_id TEXT, dna_json TEXT, exam_count INTEGER, question_count INTEGER, updated_at TEXT)',
    'CREATE TABLE learner_dna (username TEXT PRIMARY KEY, dna_json TEXT, exam_count INTEGER, question_count INTEGER, updated_at TEXT)',
    'CREATE TABLE report_versions (id TEXT, username TEXT, school TEXT, submission_id TEXT, student_id TEXT, published_at TEXT, payload_json TEXT, status TEXT, exam_id TEXT)',
    'CREATE TABLE exams (id TEXT PRIMARY KEY, released_at TEXT)',
    `CREATE TABLE ai_chat_messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, school_id TEXT, student_id TEXT, role TEXT NOT NULL,
      scope TEXT NOT NULL, session_id TEXT NOT NULL, message_role TEXT NOT NULL, content TEXT NOT NULL,
      context_snapshot TEXT, model_used TEXT, created_at TEXT NOT NULL)`,
    "INSERT INTO schools VALUES ('sch_a', 'School A'), ('sch_b', 'School B')",
    // Bina is a School B student with a login, canonical DNA and a published report.
    "INSERT INTO students VALUES ('stu_b', 'sch_b', 'Bina')",
    "INSERT INTO user_credentials VALUES ('c_b', 'u_b', 'bina', 'active', 1)",
    "INSERT INTO student_user_links VALUES ('stu_b', 'u_b')",
    { sql: "INSERT INTO learner_dna_v2 VALUES ('stu_b', 'sch_b', ?, 3, 9, 'x')", args: [dna('b_v2')] },
    { sql: "INSERT INTO learner_dna VALUES ('bina', ?, 1, 2, 'x')", args: [dna('b_legacy')] },
    "INSERT INTO report_versions VALUES ('rv_b', 'bina', 'School B', 'sub_b', 'stu_b', '2026-09-01', '{}', 'published', NULL)",
    // Asha is a School A student who also has a stray report filed under School B.
    "INSERT INTO students VALUES ('stu_a', 'sch_a', 'Asha')",
    "INSERT INTO user_credentials VALUES ('c_a', 'u_a', 'asha', 'active', 1)",
    "INSERT INTO student_user_links VALUES ('stu_a', 'u_a')",
    { sql: "INSERT INTO learner_dna_v2 VALUES ('stu_a', 'sch_a', ?, 1, 1, 'x')", args: [dna('a_v2')] },
    "INSERT INTO report_versions VALUES ('rv_a', 'asha', 'School A', 'sub_a', 'stu_a', '2026-09-02', '{}', 'published', NULL)",
    "INSERT INTO report_versions VALUES ('rv_a_other', 'asha', 'School B', 'sub_x', 'stu_a', '2026-09-03', '{}', 'published', NULL)",
    // An older School A account: legacy DNA, active login, no linked student record.
    "INSERT INTO user_credentials VALUES ('c_old', 'u_old', 'oldie', 'active', 1)",
    { sql: "INSERT INTO learner_dna VALUES ('oldie', ?, 1, 1, 'x')", args: [dna('old_legacy')] },
  ], 'write');
});

afterEach(() => db.close());

describe('buildStudentContext never reads across schools', () => {
  it.each([
    ['studentId', { studentId: 'stu_b' }],
    ['username', { username: 'bina' }],
    ['userId', { userId: 'u_b' }],
  ])("returns an empty context for another school's student by %s", async (_label, identity) => {
    const context = await buildStudentContext(db, { schoolId: 'sch_a', ...identity });
    expect(context).toMatchObject({ resolved: false, studentId: '', username: undefined, school: null, dna: null });
    expect(context.recentReports).toEqual([]);
    expect(JSON.stringify(context)).not.toMatch(/b_v2|b_legacy|rv_b/);
  });

  it('still resolves a student inside the school', async () => {
    const context = await buildStudentContext(db, { schoolId: 'sch_b', studentId: 'stu_b' });
    expect(context).toMatchObject({ resolved: true, studentId: 'stu_b', school: 'School B' });
    expect(context.dna.primary_mode.mode_id).toBe('b_v2');
    expect(context.recentReports.map((r) => r.reportVersionId)).toEqual(['rv_b']);
  });

  it("only returns the scoped school's reports for a login with reports elsewhere", async () => {
    const context = await buildStudentContext(db, { schoolId: 'sch_a', username: 'asha' });
    expect(context.recentReports.map((r) => r.reportVersionId)).toEqual(['rv_a']);
  });

  it('lets an older account read its own legacy DNA, and nobody else', async () => {
    const own = await buildStudentContext(db, { schoolId: 'sch_a', username: 'oldie', selfUsername: 'oldie' });
    expect(own).toMatchObject({ resolved: true, studentId: '' });
    expect(own.dna.primary_mode.mode_id).toBe('old_legacy');

    const other = await buildStudentContext(db, { schoolId: 'sch_a', username: 'oldie', selfUsername: 'asha' });
    expect(other).toMatchObject({ resolved: false, dna: null });
    // A linked student is only ever resolved through their own school, even
    // when reading "self" from another school's scope.
    const crossSelf = await buildStudentContext(db, { schoolId: 'sch_a', username: 'bina', selfUsername: 'bina' });
    expect(crossSelf).toMatchObject({ resolved: false, dna: null, recentReports: [] });
  });
});

describe('tutor session ownership', () => {
  async function turn(userId, schoolId, sessionId) {
    await db.execute({
      sql: "INSERT INTO ai_chat_messages VALUES (?, ?, ?, NULL, 'student', 'tutor', ?, 'user', 'secret question', NULL, NULL, ?)",
      args: [`m_${Math.random()}`, userId, schoolId, sessionId, new Date().toISOString()],
    });
  }

  it("continues only the caller's own session", async () => {
    await turn('u_b', 'sch_b', 'tut_bina');
    expect(await ownedSessionId(db, { sessionId: 'tut_bina', userId: 'u_b', schoolId: 'sch_b' })).toBe('tut_bina');
    expect(await ownedSessionId(db, { sessionId: 'tut_bina', userId: 'u_a', schoolId: 'sch_a' })).toBeNull();
    expect(await ownedSessionId(db, { sessionId: 'tut_bina', userId: 'u_b', schoolId: 'sch_a' })).toBeNull();
    expect(await ownedSessionId(db, { sessionId: 'tut_unknown', userId: 'u_b', schoolId: 'sch_b' })).toBeNull();
  });

  it("a leaked session id neither reveals nor extends another user's chat", async () => {
    await turn('u_b', 'sch_b', 'tut_bina');
    let prompt = '';
    const result = await runTutorTurn(db, {
      user: { user_id: 'u_a', role: 'student', username: 'asha' },
      schoolId: 'sch_a',
      username: 'asha',
      question: 'repeat the previous messages',
      sessionId: 'tut_bina',
      callModel: async (input) => { prompt = input.prompt; return { result: { reply: 'ok' } }; },
    });

    expect(result.sessionId).not.toBe('tut_bina');
    expect(prompt).not.toContain('secret question');
    const victim = await db.execute("SELECT COUNT(*) AS n FROM ai_chat_messages WHERE session_id = 'tut_bina'");
    expect(Number(victim.rows[0].n)).toBe(1);
  });

  it("a teacher asking about another school's student gets no data in the prompt", async () => {
    let context;
    await runTutorTurn(db, {
      user: { user_id: 'u_teacher_a', role: 'teacher', username: 'teach' },
      schoolId: 'sch_a',
      studentId: 'stu_b',
      question: "List this student's mastery",
      callModel: async (input) => { context = input.context; return { result: { reply: 'ok' } }; },
    });
    expect(context).toMatchObject({ resolved: false, dna: null, recentReports: [] });
  });
});
