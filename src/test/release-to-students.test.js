import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { releasedExamSql, seesUnreleasedResults } from '../../api/_lib/studentRelease.js';
import { loadTestReleases, releaseTestToStudents } from '../../api/vl-queue.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'skyll-release-'));
let db;

const SCHEMA = [
  'CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, slug TEXT)',
  'CREATE TABLE tests (id TEXT PRIMARY KEY, title TEXT, subject TEXT)',
  'CREATE TABLE exams (id TEXT PRIMARY KEY, school_id TEXT, source_test_id TEXT, updated_at TEXT, released_at TEXT, released_by TEXT)',
  'CREATE TABLE submissions (id TEXT PRIMARY KEY, exam_id TEXT, score REAL, max_marks REAL)',
  'CREATE TABLE report_versions (id TEXT PRIMARY KEY, submission_id TEXT, exam_id TEXT, username TEXT, status TEXT)',
  `CREATE TABLE push_notifications (id TEXT PRIMARY KEY, school TEXT, username TEXT, role TEXT, event_type TEXT, title TEXT, body TEXT,
    data_json TEXT, status TEXT, attempts INTEGER, created_at TEXT)`,
];

const SEED = [
  "INSERT INTO schools VALUES ('school_a', 'Alpha School', 'alpha-school'), ('school_b', 'Beta School', 'beta-school')",
  "INSERT INTO tests VALUES ('test_1', 'Unit Test 2', 'Physics'), ('test_2', 'Old Test', 'Physics')",
  "INSERT INTO exams VALUES ('exam_1', 'school_a', 'test_1', '2026-10-01', NULL, NULL), ('exam_2', 'school_a', 'test_2', '2026-09-01', '2026-09-02', 'teacher_a')",
  "INSERT INTO submissions VALUES ('sub_1', 'exam_1', 18, 20), ('sub_2', 'exam_1', 11, 20), ('sub_3', 'exam_2', 15, 20)",
  `INSERT INTO report_versions VALUES
    ('rv_1', 'sub_1', 'exam_1', 'asha', 'published'), ('rv_1_old', 'sub_1', 'exam_1', 'asha', 'superseded'),
    ('rv_2', 'sub_2', 'exam_1', 'ravi', 'published'), ('rv_3', 'sub_3', 'exam_2', 'asha', 'published'),
    ('rv_legacy', 'sub_x', NULL, 'asha', 'published')`,
];

const teacherA = { username: 'teacher_a', role: 'teacher', school_id: 'school_a' };
const teacherB = { username: 'teacher_b', role: 'teacher', school_id: 'school_b' };

async function visibleToStudents() {
  const result = await db.execute(`SELECT id FROM report_versions WHERE status = 'published' AND ${releasedExamSql('report_versions.exam_id')} ORDER BY id`);
  return result.rows.map((row) => row.id);
}

beforeEach(async () => {
  db?.close();
  db = createClient({ url: `file:${path.join(dir, `${Math.random()}.db`)}` });
  await db.batch([...SCHEMA, ...SEED], 'write');
});

afterAll(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });

describe('who sees a test before release', () => {
  it('lets staff see unreleased results and keeps students and parents out', () => {
    for (const role of ['teacher', 'admin', 'skyll_admin']) expect(seesUnreleasedResults({ role })).toBe(true);
    for (const role of ['student', 'parent', '', undefined]) expect(seesUnreleasedResults({ role })).toBe(false);
  });

  it('hides reports of an unreleased exam, keeping released and pre-canonical ones', async () => {
    expect(await visibleToStudents()).toEqual(['rv_3', 'rv_legacy']);
  });
});

describe('Release to students', () => {
  it('releases the test once and notifies every student with a published report', async () => {
    const result = await releaseTestToStudents(db, teacherA, { school: 'Alpha School', testId: 'test_1' }, { now: () => '2026-10-22T10:00:00.000Z' });
    expect(result).toMatchObject({ ok: true, testId: 'test_1', releasedAt: '2026-10-22T10:00:00.000Z', releasedBy: 'teacher_a', notified: 2 });
    expect(await visibleToStudents()).toEqual(['rv_1', 'rv_2', 'rv_3', 'rv_legacy']);
    const pushes = (await db.execute('SELECT username, title, body, data_json FROM push_notifications ORDER BY username')).rows;
    expect(pushes.map((row) => row.username)).toEqual(['asha', 'ravi']);
    expect(pushes[0].title).toBe('Your report is ready');
    expect(pushes[0].body).toBe('Unit Test 2: you scored 18 out of 20 in Physics. Tap to open your report.');
    expect(JSON.parse(pushes[0].data_json)).toMatchObject({ submissionId: 'sub_1', testId: 'test_1' });

    const again = await releaseTestToStudents(db, teacherA, { school: 'Alpha School', testId: 'test_1' });
    expect(again).toMatchObject({ alreadyReleased: true, releasedBy: 'teacher_a', notified: 0 });
    expect((await db.execute('SELECT COUNT(*) AS n FROM push_notifications')).rows[0].n).toBe(2);
  });

  it("refuses another school's teacher and an unknown test", async () => {
    await expect(releaseTestToStudents(db, teacherB, { school: 'Alpha School', testId: 'test_1' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(releaseTestToStudents(db, teacherA, { school: 'Alpha School', testId: 'test_missing' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(releaseTestToStudents(db, teacherA, { school: 'Alpha School' })).rejects.toMatchObject({ statusCode: 400 });
    expect(await visibleToStudents()).toEqual(['rv_3', 'rv_legacy']);
  });

  it('reports each released test for the dashboard cards', async () => {
    const releases = await loadTestReleases(db, ['test_1', 'test_2']);
    expect(releases.has('test_1')).toBe(false);
    expect(releases.get('test_2')).toEqual({ releasedAt: '2026-09-02', releasedBy: 'teacher_a' });
  });
});
