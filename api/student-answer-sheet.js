import { createClient } from '@libsql/client/web';
import { ensureAuthTables, requireUser } from './_lib/auth.js';
import { inActorSchool } from './_lib/schoolScope.js';
import { tursoAuthToken, tursoUrl } from './_lib/env.js';
import { getObject } from './_lib/storage.js';
import { indexIntakeAnswerSheetAssets } from './_lib/answerSheetAssets.js';
import { internalError } from './_lib/httpError.js';
import { releasedExamSql, seesUnreleasedResults } from './_lib/studentRelease.js';

const client = tursoUrl
  ? createClient({ url: tursoUrl, authToken: tursoAuthToken })
  : null;
let initializationPromise;

function ensureInitialized() {
  if (!initializationPromise) {
    initializationPromise = ensureAuthTables()
      .catch((error) => {
        initializationPromise = undefined;
        throw error;
      });
  }
  return initializationPromise;
}

async function resolveAllLogins(username) {
  const result = await client.execute({
    sql: `SELECT uc2.login_id FROM user_credentials uc1
          JOIN user_credentials uc2 ON uc2.user_id = uc1.user_id
          WHERE uc1.login_id = ?`,
    args: [username],
  });
  const logins = result.rows.map((row) => row.login_id);
  return logins.length ? logins : [username];
}

async function intakeSheetFor({ requestedUsername, subject, requestedTestId, releasedOnly = true }) {
  const allLogins = await resolveAllLogins(requestedUsername);
  const placeholders = allLogins.map(() => '?').join(', ');
  const result = await client.execute({
    sql: `SELECT rv.school, rv.payload_json, submission.test_id, test_student.id AS test_student_id
          FROM report_versions rv
          LEFT JOIN test_submissions submission ON submission.id = rv.submission_id
          LEFT JOIN test_students test_student
            ON test_student.test_id = submission.test_id AND test_student.student_id = submission.student_id
          WHERE rv.username IN (${placeholders}) AND rv.status = 'published'
            AND (? = '' OR submission.test_id = ?)${releasedOnly ? ` AND ${releasedExamSql('rv.exam_id')}` : ''}
          ORDER BY rv.generated_at DESC, rv.version DESC`,
    args: [...allLogins, requestedTestId || '', requestedTestId || ''],
  });
  const matched = result.rows.map((row) => ({ ...row, report: JSON.parse(row.payload_json) }))
    .find((row) => (row.report.term1?.subjects || []).some((entry) => String(entry.name || '').toLowerCase() === subject.toLowerCase()));
  if (!matched) return null;
  const testId = matched.test_id || matched.report.workflow?.test_id;
  const testStudentId = matched.test_student_id;
  if (!testId || !testStudentId) return null;
  const assets = await client.execute({
    sql: `SELECT id, storage_key, mime_type, byte_size, checksum, created_at
          FROM file_assets
          WHERE test_id = ? AND test_student_id = ? AND kind = 'answer_sheet' AND status = 'uploaded'
          ORDER BY created_at`,
    args: [testId, testStudentId],
  });
  const pages = indexIntakeAnswerSheetAssets(assets.rows);
  if (!pages.length) return null;
  return {
    report_username: requestedUsername,
    subject,
    student_id: testStudentId,
    school: matched.school || matched.report.student?.school,
    page_count: pages.length,
    source: 'intake',
    pages,
  };
}

async function intakeSheetForReview({ testId, testStudentId }) {
  const testStudent = await client.execute({
    sql: `SELECT t.school, ts.id
          FROM test_students ts
          JOIN tests t ON t.id = ts.test_id
          WHERE ts.test_id = ? AND ts.id = ?`,
    args: [testId, testStudentId],
  });
  if (!testStudent.rows.length) return null;
  const assets = await client.execute({
    sql: `SELECT id, storage_key, mime_type, byte_size, checksum, created_at
          FROM file_assets
          WHERE test_id = ? AND test_student_id = ? AND kind = 'answer_sheet' AND status = 'uploaded'
          ORDER BY created_at`,
    args: [testId, testStudentId],
  });
  const pages = indexIntakeAnswerSheetAssets(assets.rows);
  if (!pages.length) return null;
  return {
    student_id: testStudentId,
    school: testStudent.rows[0].school,
    page_count: pages.length,
    source: 'intake',
    pages,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!client) return res.status(500).json({ error: 'Database not configured' });

  try {
    await ensureInitialized();
    const user = await requireUser(req, res, ['student', 'teacher', 'admin', 'skyll_admin']);
    if (!user) return;
    const requestedUsername = String(req.query.student || user.username);
    const testId = String(req.query.testId || '').trim();
    const testStudentId = String(req.query.testStudentId || '').trim();
    const isReviewRequest = Boolean(testStudentId);
    if (isReviewRequest && (!testId || !testStudentId)) return res.status(400).json({ error: 'testId and testStudentId are required together' });
    if (isReviewRequest && !['teacher', 'admin', 'skyll_admin'].includes(user.role)) return res.status(403).json({ error: 'Reviewer access is required to review an answer sheet' });
    if (user.role === 'student' && requestedUsername !== user.username) return res.status(403).json({ error: 'You can only view your own answer sheet' });
    const subject = String(req.query.subject || 'Chemistry');
    const sheet = isReviewRequest
      ? await intakeSheetForReview({ testId, testStudentId })
      : await (async () => {
        // When testId is provided, go directly to intakeSheetFor which filters
        // by test_id. The student_answer_sheet_links table has no test_id column,
        // so it would return the wrong exam's sheets for students with multiple
        // exams in the same subject.
        const releasedOnly = !seesUnreleasedResults(user);
        if (testId) return intakeSheetFor({ requestedUsername, subject, requestedTestId: testId, releasedOnly });
        const link = await client.execute({
          sql: 'SELECT report_username, subject, student_id, school, page_count FROM student_answer_sheet_links WHERE report_username = ? AND subject = ?',
          args: [requestedUsername, subject],
        });
        return link.rows.length ? { ...link.rows[0], source: 'review' } : intakeSheetFor({ requestedUsername, subject, requestedTestId: testId, releasedOnly });
      })();
    if (!sheet) return res.status(404).json({ error: 'Your answer sheet is not available yet' });
    // Platform admins review across schools. School admins remain restricted to
    // their own school, and students can only request their own sheets above.
    if (user.role !== 'skyll_admin' && !(await inActorSchool(client, user, { schoolName: sheet.school }))) {
      return res.status(403).json({ error: 'School access denied' });
    }

    if (sheet.source === 'review') {
      return res.status(410).json({ error: 'Legacy answer sheets are no longer available.' });
    }

    const page = Number.parseInt(req.query.page, 10);
    const availablePages = sheet.pages.map((asset) => asset.page);
    if (!page) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ subject: sheet.subject, pageCount: sheet.page_count, pages: availablePages });
    }
    if (!availablePages.includes(page)) return res.status(400).json({ error: 'Invalid page' });
    const asset = sheet.pages.find((entry) => entry.page === page);
    if (!asset) return res.status(404).json({ error: 'Answer-sheet page is unavailable' });
    const object = await getObject({ key: asset.storage_key });
    if (!object.ok) return res.status(object.status === 404 ? 404 : 502).json({ error: 'Stored image is unavailable' });
    res.setHeader('Content-Type', asset.mime_type || object.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).end(Buffer.from(await object.arrayBuffer()));
  } catch (error) {
    return internalError(res, error, 'student-answer-sheet');
  }
}
