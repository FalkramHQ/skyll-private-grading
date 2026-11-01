// Shared real-SQLite setup for the CRM classes tests (FLKRM-327). Test files
// still declare their own `vi.mock`s (they are hoisted per file); this module
// only builds the schema, the two demo schools and the request helper.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const CRM_MIGRATIONS = [
  '059_crm_access_audit', '060_crm_pipeline', '061_crm_contacts', '062_crm_leads', '064_crm_lost_reason_key', '065_crm_tasks',
  '066_crm_guardian_rules', '067_crm_pipeline_requirements', '068_crm_inquiry_settings',
];

export const CLASSES_MIGRATIONS = ['075_crm_courses_rooms', '076_crm_instructors', '077_crm_timetable', '078_crm_holidays', '079_crm_session_attendance'];

export const FEES_MIGRATIONS = ['081_crm_fee_plans', '082_crm_invoices', '083_crm_payments', '084_crm_fee_guards'];

export const COMMS_MIGRATIONS = ['085_crm_whatsapp', '086_crm_comms_messages', '087_crm_access_links'];

export function migrationStatements(names) {
  return names.flatMap((name) => require(`../../../scripts/migrations/${name}.cjs`).statements);
}

export const T = '2026-06-01T00:00:00.000Z';

// The canonical roster tables as production has them (only the columns the CRM touches).
export const BASE_SCHEMA = [
  'CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT)',
  "CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, slug TEXT, status TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata')",
  'CREATE TABLE school_memberships (id TEXT PRIMARY KEY, school_id TEXT, user_id TEXT, role TEXT, status TEXT)',
  "CREATE TABLE students (id TEXT PRIMARY KEY, school TEXT, school_id TEXT, display_name TEXT, roster_key TEXT, user_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT, updated_at TEXT)",
  `CREATE TABLE batches (id TEXT PRIMARY KEY, school TEXT, name TEXT, grade TEXT, board TEXT, stream TEXT, academic_year TEXT,
     status TEXT DEFAULT 'active', created_at TEXT, updated_at TEXT, school_id TEXT, subject_id TEXT, academic_year_id TEXT)`,
  'CREATE TABLE batch_memberships (id TEXT PRIMARY KEY, batch_id TEXT, student_id TEXT, status TEXT, joined_at TEXT, left_at TEXT, created_at TEXT, updated_at TEXT)',
  "CREATE UNIQUE INDEX batch_memberships_active ON batch_memberships (batch_id, student_id) WHERE status = 'active'",
  'CREATE TABLE academic_years (id TEXT PRIMARY KEY, school_id TEXT, label TEXT, starts_on TEXT, ends_on TEXT, is_current INTEGER DEFAULT 0, UNIQUE(school_id, label))',
  'CREATE TABLE student_enrollments (id TEXT PRIMARY KEY, student_id TEXT, academic_year_id TEXT, standard TEXT NOT NULL, status TEXT, created_at TEXT, updated_at TEXT, UNIQUE(student_id, academic_year_id))',
  "CREATE TABLE subjects (id TEXT PRIMARY KEY, school_id TEXT, name TEXT, code TEXT, status TEXT DEFAULT 'active', UNIQUE(school_id, name))",
];

export const SEED = [
  "INSERT INTO schools (id, display_name, slug, status) VALUES ('sch_a', 'School A', 'school-a', 'active'), ('sch_b', 'School B', 'school-b', 'active')",
  `INSERT INTO users VALUES ('usr_admin', 'Admin A', 'active'), ('usr_admin_b', 'Admin B', 'active'), ('usr_teacher', 'Teacher A', 'active'),
     ('usr_teacher2', 'Teacher Two', 'active'), ('usr_staff', 'Staff A', 'active')`,
  `INSERT INTO school_memberships VALUES ('m1', 'sch_a', 'usr_admin', 'school_admin', 'active'), ('m2', 'sch_b', 'usr_admin_b', 'school_admin', 'active'),
     ('m3', 'sch_a', 'usr_teacher', 'teacher', 'active'), ('m4', 'sch_a', 'usr_staff', 'staff', 'active'), ('m5', 'sch_a', 'usr_teacher2', 'teacher', 'active')`,
  `INSERT INTO academic_years VALUES ('ay_26', 'sch_a', '2026-27', '2026-06-01', '2027-03-31', 1), ('ay_25', 'sch_a', '2025-26', '2025-06-01', '2026-03-31', 0),
     ('ay_b', 'sch_b', '2026-27', '2026-06-01', '2027-03-31', 1)`,
  "INSERT INTO subjects (id, school_id, name) VALUES ('sub_math', 'sch_a', 'Mathematics'), ('sub_sci', 'sch_a', 'Science'), ('sub_b', 'sch_b', 'Mathematics')",
  `INSERT INTO batches (id, school, name, grade, academic_year, status, created_at, updated_at, school_id, subject_id, academic_year_id) VALUES
     ('b_math10', 'School A', 'Grade 10 Maths', '10', '2026-27', 'active', '${T}', '${T}', 'sch_a', 'sub_math', 'ay_26'),
     ('b_sci9', 'School A', 'Grade 9 Science', '9', '2026-27', 'active', '${T}', '${T}', 'sch_a', 'sub_sci', 'ay_26'),
     ('b_other', 'School B', 'Other school batch', '9', '2026-27', 'active', '${T}', '${T}', 'sch_b', 'sub_b', 'ay_b')`,
  `INSERT INTO students (id, school, school_id, display_name, status, created_at, updated_at) VALUES
     ('stu_1', 'School A', 'sch_a', 'Anaya Iyer', 'active', '${T}', '${T}'),
     ('stu_2', 'School A', 'sch_a', 'Arjun Sharma', 'active', '${T}', '${T}'),
     ('stu_3', 'School A', 'sch_a', 'Diya Rao', 'active', '${T}', '${T}'),
     ('stu_4', 'School A', 'sch_a', 'Kabir Shah', 'inactive', '${T}', '${T}'),
     ('stu_b1', 'School B', 'sch_b', 'Other Student', 'active', '${T}', '${T}')`,
  `INSERT INTO batch_memberships VALUES ('bm_1', 'b_math10', 'stu_1', 'active', '${T}', NULL, '${T}', '${T}'),
     ('bm_2', 'b_math10', 'stu_2', 'active', '${T}', NULL, '${T}', '${T}')`,
  "INSERT INTO student_enrollments VALUES ('enr_1', 'stu_1', 'ay_26', '10', 'active', '" + T + "', '" + T + "')",
];

export const actors = {
  admin: { user_id: 'usr_admin', username: 'a_admin', role: 'admin', school_id: 'sch_a', school: 'School A' },
  otherAdmin: { user_id: 'usr_admin_b', username: 'b_admin', role: 'admin', school_id: 'sch_b', school: 'School B' },
  teacher: { user_id: 'usr_teacher', username: 'a_teacher', role: 'teacher', school_id: 'sch_a', school: 'School A' },
  teacher2: { user_id: 'usr_teacher2', username: 'a_teacher2', role: 'teacher', school_id: 'sch_a', school: 'School A' },
  staff: { user_id: 'usr_staff', username: 'a_staff', role: 'staff', school_id: 'sch_a', school: 'School A' },
};

/** `call(actor, 'POST', 'classes/courses', { body })` through the real CRM router. */
export function makeCaller(auth, handleCrmRequest) {
  return async function call(actor, method, route, { body, query = {}, headers = {} } = {}) {
    auth.sessionForRequest.mockResolvedValue(actor);
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await handleCrmRequest({ method, headers, query, body }, res, route.split('/'));
    return res;
  };
}

export async function grant(db, userId, capabilities) {
  for (const capability of capabilities) {
    await db.execute({
      sql: 'INSERT INTO crm_capability_grants (id, school_id, user_id, capability, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [`g_${userId}_${capability}`, 'sch_a', userId, capability, 'usr_admin', T, T],
    });
  }
}

export async function count(db, sql, args = []) {
  return Number((await db.execute({ sql, args })).rows[0].n);
}

export async function auditRows(db, action) {
  const result = await db.execute({ sql: 'SELECT entity_type, entity_id, summary_json, actor_user_id FROM crm_audit_events WHERE action = ? ORDER BY id', args: [action] });
  return result.rows.map((row) => ({ ...row, summary: JSON.parse(row.summary_json) }));
}
