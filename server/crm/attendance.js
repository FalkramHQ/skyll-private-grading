// Attendance (CRM-016, FLKRM-327 S5, D3, D8–D10).
//
// One row per student per class session; no row means "unmarked". A sheet's
// roster is the students whose batch membership was active when the class
// started, plus anyone already marked. A save covers one whole session and is
// all-or-nothing: every student must be on the roster, saved marks must
// carry the version the sheet showed, and changing a saved mark is a
// correction with a reason, audited per student.
//
// Who may mark: school-wide attendance writers (admins, grant holders), or —
// for roles limited to their own classes (teachers by default) — the class's
// instructor or anyone assigned to the batch, until the sheet locks seven
// days after the class. Marking opens on the class's day (school time).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { attendancePercent, correctionReasonText, markBody, markingWindow, tally } from '../../shared/crm/attendance.js';
import { addDays, localDate } from '../../shared/crm/time.js';
import { auditStatement } from './audit.js';
import { loadBatchRow } from './batches.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { isAssignedTo } from './instructors.js';
import { can, ownRecordsOnly } from './permissions.js';
import { assertRecord } from './records.js';
import { SESSION_SELECT, loadSessionRow, serializeSession } from './timetable.js';

const newId = (prefix) => `${prefix}_${randomUUID()}`;
const PENDING_DAYS_SCHOOL = 30;

export { markBody };
export const sheetQuery = z.object({ sessionId: z.string().trim().min(1).max(128) });
export const todayQuery = z.object({ view: z.enum(['mine', 'all']).default('mine') });

/** Holds `crm.attendance.write` for the whole school, not just own classes. */
function schoolWideWriter(scope) {
  return can(scope, 'crm.attendance.write') && !ownRecordsOnly(scope, 'crm.attendance.write');
}

/** Marks only their own classes (teachers by default, D3). Read-only viewers are not limited. */
function ownClassMarker(scope) {
  return can(scope, 'crm.attendance.write') && ownRecordsOnly(scope, 'crm.attendance.write');
}

async function isOwnClass(db, scope, session) {
  if (!scope.actor.user_id) return false;
  return session.instructor_user_id === scope.actor.user_id || isAssignedTo(db, scope, scope.actor.user_id, session.batch_id);
}

/**
 * Why this actor can't mark this session right now, or null when they can.
 * The order matters: a cancelled or future class is closed to everyone.
 */
async function blockedReason(db, scope, session) {
  if (!can(scope, 'crm.attendance.write')) return 'read_only';
  if (session.status === 'cancelled') return 'session_cancelled';
  const window = markingWindow(session.local_date, localDate(Date.now(), scope.timezone));
  if (window === 'not_yet') return 'not_yet';
  if (schoolWideWriter(scope)) return null;
  if (!(await isOwnClass(db, scope, session))) return 'not_your_class';
  if (window === 'locked') return 'attendance_locked';
  return null;
}

const BLOCKED = {
  read_only: [403, 'forbidden', 'You can view attendance but not mark it'],
  session_cancelled: [422, 'session_cancelled', 'This class was cancelled. Undo the cancel before taking attendance.'],
  not_yet: [422, 'not_yet', 'Attendance opens on the day of the class'],
  not_your_class: [403, 'not_your_class', 'Not your class. Only its instructor or the batch\'s teachers can take attendance.'],
  attendance_locked: [403, 'attendance_locked', 'Attendance locks 7 days after the class. Ask an admin to change it.'],
};

/** Students on the sheet: members when the class started, plus anyone already marked. */
async function rosterFor(db, scope, session) {
  const [members, marks] = await Promise.all([
    db.execute({
      sql: `SELECT st.id AS student_id, st.display_name, m.id AS membership_id
            FROM batch_memberships m
            JOIN students st ON st.id = m.student_id AND st.school_id = ? AND st.status != 'archived'
            WHERE m.batch_id = ? AND (m.joined_at IS NULL OR m.joined_at <= ?) AND (m.left_at IS NULL OR m.left_at > ?)
            ORDER BY m.joined_at DESC`,
      args: [scope.schoolId, session.batch_id, session.starts_at, session.starts_at],
    }),
    db.execute({
      sql: `SELECT a.*, st.display_name, mu.display_name AS marked_by_name, uu.display_name AS updated_by_name
            FROM crm_session_attendance a
            JOIN students st ON st.id = a.student_id AND st.school_id = a.school_id
            LEFT JOIN users mu ON mu.id = a.marked_by
            LEFT JOIN users uu ON uu.id = a.updated_by
            WHERE a.school_id = ? AND a.session_id = ?`,
      args: [scope.schoolId, session.id],
    }),
  ]);
  const roster = new Map();
  for (const row of members.rows) {
    if (!roster.has(row.student_id)) roster.set(row.student_id, { studentId: row.student_id, name: row.display_name, membershipId: row.membership_id, mark: null });
  }
  for (const row of marks.rows) {
    const entry = roster.get(row.student_id) || { studentId: row.student_id, name: row.display_name, membershipId: row.membership_id, mark: null };
    entry.mark = row;
    roster.set(row.student_id, entry);
  }
  return [...roster.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
}

function serializeStudent(entry) {
  const row = entry.mark;
  return {
    studentId: entry.studentId,
    name: entry.name,
    status: row?.status || null,
    note: row?.note || null,
    version: row ? Number(row.version) : null,
    markedBy: row ? row.marked_by_name || null : null,
    updatedBy: row && row.updated_by ? row.updated_by_name || null : null,
    updatedAt: row ? row.updated_at : null,
  };
}

function countsFor(students) {
  return { ...tally(students.map((student) => student.status)), unmarked: students.filter((student) => !student.status).length };
}

async function buildSheet(db, scope, session) {
  const [students, blocked] = await Promise.all([rosterFor(db, scope, session).then((list) => list.map(serializeStudent)), blockedReason(db, scope, session)]);
  return {
    session: serializeSession(session, scope),
    students,
    counts: countsFor(students),
    canMark: blocked === null,
    blockedReason: blocked,
    // School-wide writers can still correct after this date; own-class markers can't.
    locksAfter: addDays(session.local_date, 7),
    schoolWide: schoolWideWriter(scope),
  };
}

export async function getSheet({ db, scope, input }) {
  return buildSheet(db, scope, await loadSessionRow(db, scope, input.query.sessionId));
}

function attendanceConflict(studentIds) {
  return new CrmHttpError(409, 'attendance_conflict', 'Attendance was changed by someone else meanwhile. Reload the sheet and try again.', { studentIds });
}

/**
 * Statement that aborts the whole batch (primary-key clash on a copy of the
 * row) when the row is no longer at `version`, so a stale correction can
 * never leave a half-saved sheet.
 */
function staleGuard(rowId, version) {
  return {
    sql: `INSERT INTO crm_session_attendance (id, school_id, session_id, student_id, status, marked_at, created_at, updated_at)
          SELECT id, school_id, session_id, student_id, status, marked_at, created_at, updated_at FROM crm_session_attendance WHERE id = ? AND version != ?`,
    args: [rowId, version],
  };
}

/** Aborts the batch if the session was cancelled in the meantime. */
function notCancelledGuard(sessionId) {
  return { sql: "INSERT INTO crm_class_sessions SELECT * FROM crm_class_sessions WHERE id = ? AND status = 'cancelled'", args: [sessionId] };
}

export async function markAttendance({ db, scope, input }) {
  const { sessionId, marks } = input.body;
  const session = await loadSessionRow(db, scope, sessionId);
  const blocked = await blockedReason(db, scope, session);
  if (blocked) {
    const [status, code, message] = BLOCKED[blocked];
    throw new CrmHttpError(status, code, message);
  }

  const roster = new Map((await rosterFor(db, scope, session)).map((entry) => [entry.studentId, entry]));
  const outside = marks.filter((item) => !roster.has(item.studentId)).map((item) => item.studentId);
  if (outside.length) throw new CrmHttpError(422, 'not_on_roster', 'Some students aren\'t on this class\'s roster', { studentIds: outside });

  const now = new Date().toISOString();
  const actorId = scope.actor.user_id || null;
  const guards = [];
  const writes = [];
  const corrections = [];
  const stale = [];
  const missingReason = [];
  let firstMarks = 0;

  for (const item of marks) {
    const { mark: row, membershipId } = roster.get(item.studentId);
    const note = item.note || null;
    if (!row) {
      // A first mark. A version means the sheet thought it was saved: someone else's row vanished? Treat as stale.
      if (item.expectedVersion) { stale.push(item.studentId); continue; }
      firstMarks += 1;
      writes.push({
        sql: `INSERT INTO crm_session_attendance (id, school_id, session_id, student_id, membership_id, status, note, marked_by, marked_at, updated_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [newId('att'), scope.schoolId, session.id, item.studentId, membershipId || null, item.status, note, actorId, now, actorId, now, now],
      });
      continue;
    }
    if (row.status === item.status && (row.note || null) === note) continue;
    if (!item.expectedVersion || item.expectedVersion !== Number(row.version)) { stale.push(item.studentId); continue; }
    if (row.status !== item.status) {
      if (!item.reasonKey) { missingReason.push(item.studentId); continue; }
      corrections.push({ studentId: item.studentId, from: row.status, to: item.status, reason: correctionReasonText(item.reasonKey, item.reasonNote), reasonKey: item.reasonKey });
    }
    guards.push(staleGuard(row.id, item.expectedVersion));
    writes.push({
      sql: 'UPDATE crm_session_attendance SET status = ?, note = ?, updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?',
      args: [item.status, note, actorId, now, row.id, item.expectedVersion],
    });
  }
  if (stale.length) throw attendanceConflict(stale);
  if (missingReason.length) {
    throw new CrmHttpError(422, 'reason_required', 'Changing a saved mark needs a reason', missingReason.map((studentId) => ({ studentId })));
  }
  if (!writes.length) return buildSheet(db, scope, session);

  const statements = [
    notCancelledGuard(session.id),
    ...guards,
    ...writes,
    // The first attendance save holds the class (D6); timetable edits then never touch it.
    { sql: "UPDATE crm_class_sessions SET status = 'held', version = version + 1, updated_at = ? WHERE id = ? AND status = 'scheduled'", args: [now, session.id] },
    auditStatement(scope, {
      action: 'attendance.marked', entityId: session.id,
      summary: { batchId: session.batch_id, localDate: session.local_date, firstMarks, corrections: corrections.length, counts: tally(marks.map((item) => item.status)) },
      now,
    }),
    ...corrections.map((correction) => auditStatement(scope, {
      action: 'attendance.corrected', entityId: correction.studentId,
      summary: { studentId: correction.studentId, sessionId: session.id, from: correction.from, to: correction.to, reason: correction.reason, reasonKey: correction.reasonKey },
      now,
    })),
  ];
  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''))) {
      const current = await loadSessionRow(db, scope, session.id);
      if (current.status === 'cancelled') throw new CrmHttpError(422, 'session_cancelled', BLOCKED.session_cancelled[2]);
      throw attendanceConflict(marks.map((item) => item.studentId));
    }
    throw error;
  }
  return buildSheet(db, scope, await loadSessionRow(db, scope, session.id));
}

// ---------------------------------------------------------------- lists --

/** Sessions an own-classes marker can take: they teach it, or teach the batch. */
const OWN_CLASS_SQL = `(s.instructor_user_id = ? OR EXISTS (
  SELECT 1 FROM crm_batch_instructors bi WHERE bi.school_id = s.school_id AND bi.batch_id = s.batch_id AND bi.user_id = ? AND bi.status = 'active'))`;

const PROGRESS_SQL = `,
  (SELECT COUNT(*) FROM crm_session_attendance a WHERE a.session_id = s.id) AS marked_count,
  (SELECT COUNT(*) FROM batch_memberships m JOIN students st ON st.id = m.student_id AND st.status != 'archived'
     WHERE m.batch_id = s.batch_id AND (m.joined_at IS NULL OR m.joined_at <= s.starts_at) AND (m.left_at IS NULL OR m.left_at > s.starts_at)) AS roster_count`;

function withProgress(row, scope, nowIso) {
  return { ...serializeSession(row, scope, nowIso), markedCount: Number(row.marked_count || 0), rosterCount: Number(row.roster_count || 0) };
}

/** Today's classes with marking progress: mine (own-classes markers always), or the whole school. */
export async function attendanceToday({ db, scope, input }) {
  const today = localDate(Date.now(), scope.timezone);
  // Own-class markers see their classes; read-only viewers see the school (viewing is school-wide).
  const view = ownClassMarker(scope) ? 'mine' : schoolWideWriter(scope) ? input.query.view : 'all';
  const clauses = ['s.school_id = ?', 's.local_date = ?'];
  const args = [scope.schoolId, today];
  if (view === 'mine') { clauses.push(OWN_CLASS_SQL); args.push(scope.actor.user_id || '', scope.actor.user_id || ''); }
  const select = SESSION_SELECT.replace('sj.name AS subject_name', `sj.name AS subject_name${PROGRESS_SQL}`);
  const result = await db.execute({ sql: `${select} WHERE ${clauses.join(' AND ')} ORDER BY s.starts_at, b.name`, args });
  const nowIso = new Date().toISOString();
  return { view, items: result.rows.map((row) => withProgress(row, scope, nowIso)), nextCursor: null };
}

/**
 * Classes that ended with no attendance: own-classes markers see theirs that
 * are still unlocked; everyone else sees the school's last 30 days. Classes
 * with an empty roster are left out.
 */
export async function attendancePending({ db, scope }) {
  const today = localDate(Date.now(), scope.timezone);
  const own = ownClassMarker(scope);
  const nowIso = new Date().toISOString();
  const clauses = ['s.school_id = ?', "s.status = 'scheduled'", 's.ends_at < ?', 's.local_date >= ?'];
  const args = [scope.schoolId, nowIso, addDays(today, own ? -7 : -PENDING_DAYS_SCHOOL)];
  if (own) { clauses.push(OWN_CLASS_SQL); args.push(scope.actor.user_id || '', scope.actor.user_id || ''); }
  const select = SESSION_SELECT.replace('sj.name AS subject_name', `sj.name AS subject_name${PROGRESS_SQL}`);
  const result = await db.execute({ sql: `${select} WHERE ${clauses.join(' AND ')} ORDER BY s.starts_at DESC LIMIT 200`, args });
  // A class nobody was enrolled in can't be marked, so it never waits.
  const items = result.rows.filter((row) => Number(row.roster_count) > 0).map((row) => withProgress(row, scope, nowIso));
  return { scope: own ? 'own' : 'school', items, nextCursor: null };
}

// ---------------------------------------------------------------- S6: summaries --

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SUMMARY_DAYS = 366;

export const studentSummaryQuery = z.object({ studentId: z.string().trim().min(1).max(128) });
export const batchSummaryQuery = z.object({
  batchId: z.string().trim().min(1).max(128),
  from: z.string().regex(DATE),
  to: z.string().regex(DATE),
});
export const registerQuery = z.object({
  batchId: z.string().trim().min(1).max(128),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

/** The current academic year's dates, or the last year when none is set. */
async function yearRange(db, scope) {
  const result = await db.execute({
    sql: 'SELECT label, starts_on, ends_on FROM academic_years WHERE school_id = ? AND is_current = 1 LIMIT 1',
    args: [scope.schoolId],
  });
  const today = localDate(Date.now(), scope.timezone);
  const row = result.rows[0];
  if (row?.starts_on) return { from: String(row.starts_on).slice(0, 10), to: row.ends_on ? String(row.ends_on).slice(0, 10) : today, label: row.label };
  return { from: addDays(today, -365), to: today, label: 'Last 12 months' };
}

function withPercent(counts) {
  return { ...counts, percent: attendancePercent(counts) };
}

function emptyCounts() {
  return { present: 0, absent: 0, late: 0, excused: 0, notMarked: 0 };
}

function onRosterAt(memberships, startsAt) {
  return memberships.some((m) => (!m.joined_at || m.joined_at <= startsAt) && (!m.left_at || m.left_at > startsAt));
}

/**
 * The batch's sessions in `[from, to]`, its students (anyone a member during
 * a session, or marked in one), and each student's cell per session:
 * a status, 'cancelled', 'not_marked' (past, on the roster, no mark),
 * 'upcoming', or null (not in the batch then).
 */
async function batchGrid(db, scope, batch, from, to) {
  const nowIso = new Date().toISOString();
  const [sessions, memberships] = await Promise.all([
    db.execute({
      sql: `SELECT id, local_date, starts_at, ends_at, status FROM crm_class_sessions
            WHERE school_id = ? AND batch_id = ? AND local_date >= ? AND local_date <= ? ORDER BY starts_at`,
      args: [scope.schoolId, batch.id, from, to],
    }),
    db.execute({
      sql: `SELECT m.student_id, m.joined_at, m.left_at, st.display_name FROM batch_memberships m
            JOIN students st ON st.id = m.student_id AND st.school_id = ? AND st.status != 'archived'
            WHERE m.batch_id = ?`,
      args: [scope.schoolId, batch.id],
    }),
  ]);
  const ids = sessions.rows.map((row) => row.id);
  const marks = ids.length
    ? await db.execute({
      sql: `SELECT a.session_id, a.student_id, a.status, st.display_name FROM crm_session_attendance a
            JOIN students st ON st.id = a.student_id AND st.school_id = a.school_id
            WHERE a.school_id = ? AND a.session_id IN (${ids.map(() => '?').join(', ')})`,
      args: [scope.schoolId, ...ids],
    })
    : { rows: [] };
  const markBy = new Map(marks.rows.map((row) => [`${row.session_id}:${row.student_id}`, row.status]));
  const people = new Map();
  for (const row of memberships.rows) {
    if (!people.has(row.student_id)) people.set(row.student_id, { studentId: row.student_id, name: row.display_name, memberships: [] });
    people.get(row.student_id).memberships.push(row);
  }
  for (const row of marks.rows) if (!people.has(row.student_id)) people.set(row.student_id, { studentId: row.student_id, name: row.display_name, memberships: [] });

  const students = [];
  for (const person of people.values()) {
    const cells = sessions.rows.map((session) => {
      const status = markBy.get(`${session.id}:${person.studentId}`);
      if (status) return status;
      if (!onRosterAt(person.memberships, session.starts_at)) return null;
      if (session.status === 'cancelled') return 'cancelled';
      return session.ends_at < nowIso ? 'not_marked' : 'upcoming';
    });
    // People who were never in the batch during the range don't appear.
    if (cells.every((cell) => cell === null)) continue;
    const counts = emptyCounts();
    for (const cell of cells) {
      if (cell === 'not_marked') counts.notMarked += 1;
      else if (cell in counts) counts[cell] += 1;
    }
    students.push({ studentId: person.studentId, name: person.name, counts: withPercent(counts), cells });
  }
  return {
    sessions: sessions.rows.map((row) => ({ id: row.id, localDate: row.local_date, startsAt: row.starts_at, status: row.status })),
    students,
  };
}

function assertRange(from, to) {
  if (to < from) throw crmErrors.validation([{ path: 'to', message: 'The end must be on or after the start' }]);
  if (Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) > MAX_SUMMARY_DAYS) {
    throw crmErrors.validation([{ path: 'to', message: 'Ask for at most a year at a time' }]);
  }
}

/** Per-student % for a batch over a range, lowest first (D11). */
export async function batchSummary({ db, scope, input }) {
  const { batchId, from, to } = input.query;
  assertRange(from, to);
  const batch = await loadBatchRow(db, scope, batchId);
  const grid = await batchGrid(db, scope, batch, from, to);
  const students = grid.students.map(({ cells: _cells, ...student }) => student)
    .sort((a, b) => (a.counts.percent ?? 101) - (b.counts.percent ?? 101) || String(a.name).localeCompare(String(b.name)));
  const overall = emptyCounts();
  for (const student of students) for (const key of Object.keys(overall)) overall[key] += student.counts[key];
  return {
    batch: { id: batch.id, name: batch.name },
    from, to,
    classesHeld: grid.sessions.filter((session) => session.status === 'held').length,
    classesCancelled: grid.sessions.filter((session) => session.status === 'cancelled').length,
    overall: withPercent(overall),
    students,
  };
}

/** A month of the batch's classes as a students × dates register (D11). */
export async function batchRegister({ db, scope, input }) {
  const { batchId, month } = input.query;
  const batch = await loadBatchRow(db, scope, batchId);
  const [year, monthNumber] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const grid = await batchGrid(db, scope, batch, from, to);
  return {
    batch: { id: batch.id, name: batch.name },
    month,
    sessions: grid.sessions,
    students: grid.students.sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' })),
  };
}

/** A student's attendance this academic year, overall and per batch, plus their last 10 classes (D11). */
export async function studentSummary({ db, scope, input }) {
  const { studentId } = input.query;
  await assertRecord(db, scope, 'student', studentId, 'read');
  const range = await yearRange(db, scope);
  const nowIso = new Date().toISOString();
  // Every class of a batch the student was in when it started, with their mark.
  const result = await db.execute({
    sql: `SELECT s.id, s.batch_id, b.name AS batch_name, s.local_date, s.starts_at, s.ends_at, s.status AS session_status, a.status AS mark
          FROM crm_class_sessions s
          JOIN batches b ON b.id = s.batch_id AND b.school_id = s.school_id
          LEFT JOIN crm_session_attendance a ON a.session_id = s.id AND a.student_id = ?
          WHERE s.school_id = ? AND s.local_date >= ? AND s.local_date <= ?
            AND (a.id IS NOT NULL OR EXISTS (
              SELECT 1 FROM batch_memberships m WHERE m.batch_id = s.batch_id AND m.student_id = ?
                AND (m.joined_at IS NULL OR m.joined_at <= s.starts_at) AND (m.left_at IS NULL OR m.left_at > s.starts_at)))
          ORDER BY s.starts_at DESC`,
    args: [studentId, scope.schoolId, range.from, range.to, studentId],
  });
  const overall = emptyCounts();
  const byBatch = new Map();
  const recent = [];
  for (const row of result.rows) {
    const cell = row.mark || (row.session_status === 'cancelled' ? 'cancelled' : row.ends_at < nowIso ? 'not_marked' : 'upcoming');
    if (cell === 'upcoming') continue;
    if (!byBatch.has(row.batch_id)) byBatch.set(row.batch_id, { batchId: row.batch_id, name: row.batch_name, counts: emptyCounts() });
    const counts = byBatch.get(row.batch_id).counts;
    for (const target of [overall, counts]) {
      if (cell === 'not_marked') target.notMarked += 1;
      else if (cell in target) target[cell] += 1;
    }
    if (recent.length < 10) recent.push({ sessionId: row.id, localDate: row.local_date, batchName: row.batch_name, status: cell });
  }
  return {
    range,
    overall: withPercent(overall),
    batches: [...byBatch.values()].map((batch) => ({ ...batch, counts: withPercent(batch.counts) })),
    recent,
  };
}
