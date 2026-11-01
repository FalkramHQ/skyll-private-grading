// Two schools seeded identically for the role × school matrix (FLKRM-386).
// Every School A row carries ALPHA_SECRET and every School B row BETA_SECRET,
// so a response can be checked for data it must never contain.
import { createSchemaDatabase } from '../helpers/schemaDatabase.js';

export const ALPHA_SECRET = 'ALPHA_SECRET';
export const BETA_SECRET = 'BETA_SECRET';

export const SCHOOLS = {
  a: { id: 'sch_a', slug: 'alpha-academy', name: 'Alpha Academy', marker: ALPHA_SECRET },
  b: { id: 'sch_b', slug: 'beta-institute', name: 'Beta Institute', marker: BETA_SECRET },
};

const actor = (key, username, role, school) => ({
  key, user_id: `u_${username}`, username, role, school: school.name, school_id: school.id,
});

/** The six actors the matrix runs every route as. */
export const ACTORS = {
  studentA: actor('studentA', 'stu_a', 'student', SCHOOLS.a),
  peerA: actor('peerA', 'stu_a_peer', 'student', SCHOOLS.a),
  teacherA: actor('teacherA', 'teacher_a', 'teacher', SCHOOLS.a),
  adminA: actor('adminA', 'admin_a', 'admin', SCHOOLS.a),
  teacherB: actor('teacherB', 'teacher_b', 'teacher', SCHOOLS.b),
  // Not in the issue's list, but without it admin-only routes would only ever
  // refuse School B by role, never exercise the school check itself.
  adminB: actor('adminB', 'admin_b', 'admin', SCHOOLS.b),
  skyll: actor('skyll', 'sky_admin', 'skyll_admin', { id: 'sch_platform', name: 'Skyll HQ' }),
};

/** Ids of the School A records the matrix targets. */
export const A = {
  school: SCHOOLS.a,
  testId: 'test_a',
  rubricTestId: 'test_a_rubric',
  examId: 'exam_a',
  studentId: 'stu_a1',
  testStudentId: 'ts_a',
  username: 'stu_a',
  submissionId: 'sub_a1',
  questionId: 'q_a1',
  jobId: 'job_a',
  collectionId: 'coll_a',
  runId: 'run_a',
  assetId: 'asset_a',
  invoiceId: 'inv_a',
  subject: 'Physics',
  grade: '9',
};

function seedSchool(key) {
  const sc = SCHOOLS[key];
  const m = sc.marker;
  const t = '2026-09-01T10:00:00.000Z';
  const recent = new Date(Date.now() - 60_000).toISOString();
  const id = (base) => `${base}_${key}`;
  const studentUser = key === 'a' ? 'stu_a' : 'stu_b';
  return [
    ['INSERT INTO schools (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [sc.id, sc.slug, sc.name, 'active', t, t]],
    ['INSERT INTO subjects (id, school_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id('subj'), sc.id, 'Physics', t, t]],
    // Students: the main one (with a login) and a classmate.
    ['INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [`u_${studentUser}`, `${m} Student`, 'active', t, t]],
    ['INSERT INTO user_credentials (id, user_id, login_id, password_hash, credential_type, is_primary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)', [id('cred'), `u_${studentUser}`, studentUser, 'x', 'password', 'active', t, t]],
    ['INSERT INTO students (id, school, school_id, display_name, status, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [`stu_${key}1`, sc.name, sc.id, `${m} Asha`, 'active', `u_${studentUser}`, t, t]],
    ['INSERT INTO students (id, school, school_id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [`stu_${key}2`, sc.name, sc.id, `${m} Peer`, 'active', t, t]],
    ['INSERT INTO student_user_links (student_id, user_id, school_id, linked_by, linked_at) VALUES (?, ?, ?, ?, ?)', [`stu_${key}1`, `u_${studentUser}`, sc.id, 'seed', t]],
    ['INSERT INTO batches (id, school, school_id, name, grade, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id('bat'), sc.name, sc.id, `${m} Batch`, '9', 'active', t, t]],
    ['INSERT INTO batch_memberships (id, batch_id, student_id, status, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id('bm'), id('bat'), `stu_${key}1`, 'active', t, t, t]],
    // Intake test (uploads in progress) and a second one parked for rubric review.
    ['INSERT INTO tests (id, school, school_id, title, subject, grade, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [`test_${key}`, sc.name, sc.id, `${m} Physics Test`, 'Physics', '9', 'uploading', 'seed', t, t]],
    ['INSERT INTO tests (id, school, school_id, title, subject, grade, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [`test_${key}_rubric`, sc.name, sc.id, `${m} Rubric Test`, 'Physics', '9', 'rubric_ready_for_review', 'seed', t, t]],
    ['INSERT INTO exam_rubric_versions (id, test_id, job_id, version, status, model, source_ocr_run_ids_json, question_map_json, quality_json, created_at, is_active) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1)', [id('erv'), `test_${key}_rubric`, id('rjob'), 'succeeded', 'test-model', '[]', JSON.stringify({ questions: [{ number: 'Q1', marks: 5, question_text: `${m} rubric question`, answer_key: 'a' }] }), '{}', t]],
    ['INSERT INTO test_students (id, test_id, student_id, student_name, created_at) VALUES (?, ?, ?, ?, ?)', [id('ts'), `test_${key}`, `stu_${key}1`, `${m} Asha`, t]],
    ['INSERT INTO file_assets (id, test_id, kind, storage_key, mime_type, byte_size, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [`asset_${key}`, `test_${key}`, 'question_paper', `skyll/${sc.slug}/qp.png`, 'image/png', 10, 'uploaded', 'seed', t]],
    // Canonical exam chain: exam → set → question → submission → v2 question → report.
    ['INSERT INTO exams (id, source_test_id, school_id, subject_id, academic_year_id, name, grade, status, created_at, updated_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [`exam_${key}`, `test_${key}`, sc.id, id('subj'), id('ay'), `${m} Exam`, '9', 'collecting', t, t, t]],
    ['INSERT INTO exam_sets (id, exam_id, set_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id('set'), `exam_${key}`, 'A', t, t]],
    ['INSERT INTO exam_set_questions (id, set_id, question_number, question_text, max_marks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id('esq'), id('set'), 'Q1', `${m} question`, 5, t, t]],
    ['INSERT INTO submissions (id, exam_id, student_id, status, score, max_marks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [`sub_${key}1`, `exam_${key}`, `stu_${key}1`, 'graded', 3, 5, t, t]],
    ['INSERT INTO submission_questions_v2 (id, submission_id, exam_set_question_id, question_number, ai_marks, status, evidence_json, source_asset_ids_json, render_json, review_revision, regraded_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)', [`q_${key}1`, `sub_${key}1`, id('esq'), 'Q1', 3, 'pending', '{}', '[]', JSON.stringify({ question_text: `${m} Q`, student_answer: { studentWrote: `${m} answer` } }), t, t]],
    ['INSERT INTO report_versions (id, submission_id, version, status, generated_at, published_at, payload_json, username, school, exam_id, student_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)', [id('rv'), `sub_${key}1`, 'published', t, t, JSON.stringify({ student: { name: `${m} Asha`, class: '9th', school: sc.name }, exams: [{ id: `exam_${key}`, name: `${m} Exam` }], term1: { subjects: [{ name: 'Physics', score: 3, max: 5, total: 5 }] } }), studentUser, sc.name, `exam_${key}`, `stu_${key}1`]],
    ['INSERT INTO recheck_requests (id, submission_question_id, submission_id, student_id, reason, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id('rr'), `q_${key}1`, `sub_${key}1`, `stu_${key}1`, `${m} recheck reason`, 'open', t]],
    // Operations, devices, notes, events.
    ['INSERT INTO processing_jobs (id, test_id, school, type, status, payload_json, requested_by, requested_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [`job_${key}`, `test_${key}`, sc.name, 'mistral_ocr', 'failed_retryable', '{}', 'seed', t, `${m} job error`]],
    ['INSERT INTO intake_installations (installation_id, school, username, platform, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id('inst'), sc.name, `${m}_device_user`, 'android', recent, t]],
    ['INSERT INTO exam_note_collections (id, school, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [`coll_${key}`, sc.name, `${m} notes`, 'seed', t, t]],
    ['INSERT INTO user_events (id, user_id, username, role, school_id, school, event_type, event_data, platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id('ev'), `u_${studentUser}`, `${m}_user`, 'student', sc.id, sc.name, 'login', '{}', 'web', recent]],
    // Cohort regrade run with a failed item (for get / retry).
    ['INSERT INTO regrade_runs (id, exam_id, school_id, scope, status, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [`run_${key}`, `exam_${key}`, sc.id, JSON.stringify({ school: sc.name, subject: `${m} Physics`, grade: '9', test_id: `test_${key}` }), 'partial', 'seed', t]],
    ['INSERT INTO regrade_items (id, run_id, submission_id, submission_question_id, revision, state) VALUES (?, ?, ?, ?, 1, ?)', [id('ri'), `run_${key}`, `sub_${key}1`, `q_${key}1`, 'failed']],
    ['INSERT INTO cohort_completion_overrides (id, school, test_id, marked_by, marked_at) VALUES (?, ?, ?, ?, ?)', [id('cco'), sc.name, `test_${key}`, 'seed', t]],
    ['INSERT INTO school_billing_profiles (school_id, legal_name, address, place_of_supply, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [sc.id, `${m} Legal Pvt Ltd`, `${m} Road, Pune`, 'Maharashtra', 'seed', t, t]],
    ['INSERT INTO invoices (id, school_id, period, fy, seq, number, status, invoice_date, paper_count, subtotal_paise, round_off_paise, total_paise, bill_to_json, issued_by, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [`inv_${key}`, sc.id, '2026-09', '2026-27', key === 'a' ? 1 : 2, `SKY/2026-27/000${key === 'a' ? 1 : 2}`, 'issued', '2026-10-02', 1, 125, 0, 125, JSON.stringify({ legalName: `${m} Legal Pvt Ltd` }), 'seed', t]],
    // Learner analytics for the AI teacher routes.
    ['INSERT INTO learner_dna_v2 (student_id, school_id, dna_json, exam_count, question_count, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)', [`stu_${key}1`, sc.id, JSON.stringify({ primary_mode: { mode_id: 'maker', title: `${m} mode` } }), t, t]],
    ['INSERT INTO early_warnings (id, school_id, student_id, exam_id, username, student_name, severity, reasons_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id('ew'), sc.id, `stu_${key}1`, `exam_${key}`, studentUser, `${m} Asha`, 'high', JSON.stringify([`${m} falling`]), 'open', t, t]],
    // AI artifacts are private to their author within the school: one per staff user.
    ...[`u_teacher_${key}`, `u_admin_${key}`, 'u_sky_admin'].map((userId) => (
      ['INSERT INTO ai_artifacts (id, school_id, user_id, artifact_type, scope_json, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [`art_${key}_${userId}`, sc.id, userId, 'lesson_plan', '{}', JSON.stringify({ title: `${m} plan` }), t]]
    )),
  ];
}

/** A fresh database (full production schema) seeded with both schools. */
export async function createTwoSchoolDatabase() {
  const db = await createSchemaDatabase();
  await db.batch([...seedSchool('a'), ...seedSchool('b')].map(([sql, args]) => ({ sql, args })), 'write');
  return db;
}
