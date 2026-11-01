import { database, ensureAuthTables, requireUser } from './_lib/auth.js';
import { inActorSchool } from './_lib/schoolScope.js';
import { resolveSchoolId } from './_lib/canonicalSubmissions.js';
import { generateLongitudinalDna } from './_lib/learnerDnaRefresh.js';
import { internalError } from './_lib/httpError.js';
import { releasedExamSql, seesUnreleasedResults } from './_lib/studentRelease.js';

/* Canonical-first sub-part hydration. The published report snapshot already
 * carries structured `parts` (emitted by the worker into payload_json /
 * render_json). For any question whose snapshot lacks parts, prefer the
 * canonical submission_questions_v2.render_json.gradeParts so readers always
 * show structured sub-part rows when canonical data exists, and otherwise fall
 * back to the legacy flattened prose already present in the report. Non-fatal:
 * any failure leaves the report untouched. */
async function hydrateCanonicalParts(db, submissionId, subjects) {
  if (!submissionId) return subjects;
  try {
    const result = await db.execute({
      sql: `SELECT question_number, render_json FROM submission_questions_v2 WHERE submission_id = ?`,
      args: [submissionId],
    }).catch(() => ({ rows: [] }));
    const byNumber = new Map();
    for (const row of result.rows) {
      const parts = JSON.parse(row.render_json || '{}').gradeParts;
      if (Array.isArray(parts) && parts.length) byNumber.set(String(row.question_number), parts);
    }
    if (!byNumber.size) return subjects;
    return subjects.map((subject) => ({
      ...subject,
      questions: (subject.questions || []).map((question) => {
        if (Array.isArray(question.parts) && question.parts.length) return question;
        const canonicalParts = byNumber.get(String(question.number));
        if (!canonicalParts) return question;
        return { ...question, parts: canonicalParts, parts_source: 'canonical' };
      }),
    }));
  } catch {
    return subjects;
  }
}

/**
 * Merge multiple report_versions rows (one per exam) into a unified student report.
 * Each row's payload has: exams: [{id, name, date}], term1: {overall_insights, subjects: [one subject]}
 * The merged result has: exams array, per-exam data under examId keys, term1 = most recent exam.
 */
function mergeReportVersions(rows, storedDna = null) {
  if (!rows.length) return null;
  const reports = rows.map((row) => JSON.parse(row.payload_json));
  const first = reports[0]; // most recent (ORDER BY published_at DESC)

  const exams = [];
  const examData = {};

  for (const report of reports) {
    const examInfo = (report.exams || [])[0] || {
      id: report.workflow?.test_id || `exam${exams.length}`,
      name: 'Assessment',
      date: report.workflow?.generated_at || '',
    };
    exams.push(examInfo);

    const examId = examInfo.id;
    if (examId && !examData[examId]) {
      examData[examId] = {
        overall_insights: report.term1?.overall_insights || { strongest_area: '', focus_needed: [], pattern: '' },
        subjects: report.term1?.subjects || [],
        workflow: report.workflow || {},
      };
    }
  }

  // Default "term1" = most recent exam's data for backward compat
  const defaultExamId = exams[0]?.id || 'term1';
  const defaultData = examData[defaultExamId] || {
    overall_insights: first.term1?.overall_insights || { strongest_area: '', focus_needed: [], pattern: '' },
    subjects: first.term1?.subjects || [],
  };

  const merged = {
    ...first,
    exams,
    term1: defaultData,
    // Use stored longitudinal DNA from learner_dna table (the "student brain").
    // Fall back to the per-assessment DNA in the report payload if the table
    // has not been populated yet.
    learner_dna: storedDna || generateLongitudinalDna(reports) || reports.find((r) => r.learner_dna)?.learner_dna || first.learner_dna || null,
    report_status: 'published',
  };

  // Add per-exam data keys so getCurrentExamData(examId) finds them
  for (const [examId, data] of Object.entries(examData)) {
    merged[examId] = data;
  }

  return merged;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res);
    if (!user) return;
    const requestedUsername = String(req.query.username || user.username);
    const db = database();

    // Resolve all login aliases for this student so reports published under
    // any credential (old partnerb_xxx or new short login) are found.
    const aliasResult = await db.execute({
      sql: `SELECT DISTINCT uc2.login_id FROM user_credentials uc1
            JOIN user_credentials uc2 ON uc2.user_id = uc1.user_id
            WHERE uc1.login_id = ?`,
      args: [requestedUsername],
    }).catch(() => ({ rows: [] }));
    const allLogins = aliasResult.rows.length
      ? aliasResult.rows.map((r) => r.login_id)
      : [requestedUsername];
    const loginList = allLogins.map(() => '?').join(', ');

    // The canonical student records behind those logins. Reports published
    // under another username still belong to this student when they carry
    // one of these ids; nothing else (not a matching name) can merge in.
    const studentIds = (await db.execute({
      sql: `SELECT sul.student_id AS id FROM user_credentials uc
              JOIN student_user_links sul ON sul.user_id = uc.user_id
              WHERE uc.login_id IN (${loginList})
            UNION
            SELECT st.id FROM user_credentials uc
              JOIN students st ON st.user_id = uc.user_id
              WHERE uc.login_id IN (${loginList})`,
      args: [...allLogins, ...allLogins],
    })).rows.map((row) => row.id).filter(Boolean);

    // Fetch ALL published report_versions for this student (one row per exam).
    // A student sees an exam only once a teacher has released it; staff see all.
    const byStudentId = studentIds.length ? ` OR student_id IN (${studentIds.map(() => '?').join(', ')})` : '';
    const showUnreleased = seesUnreleasedResults(user);
    const releasedOnly = showUnreleased ? '' : ` AND ${releasedExamSql('report_versions.exam_id')}`;
    const targetRows = await db.execute({
      sql: `SELECT username, school, student_id, submission_id, payload_json, published_at
            FROM report_versions
            WHERE (username IN (${loginList})${byStudentId}) AND status = 'published'${releasedOnly}
            ORDER BY published_at DESC`,
      args: [...allLogins, ...studentIds],
    });
    if (!targetRows.rows.length) return res.status(404).json({ error: 'Student report not found' });
    // A login can have published reports in more than one school. Merge only
    // the caller's school's rows; checking just the newest row would let a
    // teacher at A receive B's exams merged in (FLKRM-384).
    const inSchool = user.role === 'skyll_admin'
      ? null
      : await Promise.all(targetRows.rows.map((row) => inActorSchool(db, user, { schoolName: row.school })));
    const scopedRows = inSchool ? targetRows.rows.filter((_, index) => inSchool[index]) : targetRows.rows;
    if (!scopedRows.length) return res.status(403).json({ error: 'School access denied' });

    // Fetch stored longitudinal DNA (the "student brain"). Phase 5: the
    // student_id-keyed table is canonical; the legacy username row is the
    // fallback for students the rekey could not resolve.
    const dnaRow = (await db.execute({
      sql: `SELECT dna_json FROM learner_dna_v2 WHERE student_id = COALESCE(
              (SELECT sul.student_id FROM user_credentials uc JOIN student_user_links sul ON sul.user_id = uc.user_id WHERE uc.login_id = ? LIMIT 1),
              (SELECT st.id FROM user_credentials uc JOIN students st ON st.user_id = uc.user_id WHERE uc.login_id = ? LIMIT 1),
              (SELECT student_id FROM report_versions WHERE username = ? AND student_id IS NOT NULL ORDER BY published_at DESC LIMIT 1)
            ) LIMIT 1`,
      args: [requestedUsername, requestedUsername, requestedUsername],
    }).catch(() => ({ rows: [] }))).rows[0]
      || (await db.execute({
        sql: 'SELECT dna_json FROM learner_dna WHERE username = ?',
        args: [requestedUsername],
      }).catch(() => ({ rows: [] }))).rows[0];
    const storedDna = dnaRow ? JSON.parse(dnaRow.dna_json) : null;

    // Merge multiple exam reports into a unified student report
    const target = mergeReportVersions(scopedRows, storedDna);
    // Preserve submission_id from the most recent row
    target.student = { ...(target.student || {}), submission_id: target.student?.submission_id || scopedRows[0].submission_id };

    const isOwnReport = requestedUsername === user.username;
    const staffRole = ['teacher', 'admin', 'skyll_admin'].includes(user.role);
    if (!isOwnReport && !staffRole) return res.status(403).json({ error: 'You do not have permission to view this report' });
    if (user.role !== 'skyll_admin' && !(await inActorSchool(db, user, { schoolName: target.student?.school || scopedRows[0].school }))) return res.status(403).json({ error: 'School access denied' });

    const school = target.student?.school || scopedRows[0].school;
    const merged = target;

    // Rank among everyone who sat the same exams, for this student's own
    // canonical ids only.
    const targetStudentIds = new Set([...studentIds, ...scopedRows.map((row) => row.student_id).filter(Boolean)]);
    const schoolId = user.role === 'skyll_admin' ? await resolveSchoolId(db, school) : user.school_id;

    const classRanks = {};
    if (targetStudentIds.size > 0 && schoolId) {
      const ids = [...targetStudentIds];
      const idList = ids.map(() => '?').join(', ');
      // Window over only the exams this student sat, newest first, so the
      // latest exam in a subject wins when a subject has several.
      const ranksResult = await db.execute({
        sql: `SELECT student_id, exam_name, subject_name, rank_in_exam, total FROM (
                SELECT
                  s.student_id,
                  e.name AS exam_name,
                  e.exam_date,
                  e.created_at,
                  sub.name AS subject_name,
                  RANK() OVER (PARTITION BY s.exam_id ORDER BY s.score DESC) AS rank_in_exam,
                  COUNT(s.id) OVER (PARTITION BY s.exam_id) AS total
                FROM submissions s
                JOIN exams e ON e.id = s.exam_id
                LEFT JOIN subjects sub ON sub.id = e.subject_id
                WHERE e.school_id = ? AND s.status != 'archived'${showUnreleased ? '' : ' AND e.released_at IS NOT NULL'}
                  AND s.exam_id IN (SELECT exam_id FROM submissions WHERE student_id IN (${idList}))
              )
              WHERE student_id IN (${idList})
              ORDER BY COALESCE(exam_date, created_at) DESC`,
        args: [schoolId, ...ids, ...ids],
      });

      for (const row of ranksResult.rows) {
        const key = row.subject_name || row.exam_name;
        if (!classRanks[key]) {
          const percentile = Math.round(((row.total + 1 - row.rank_in_exam) / row.total) * 100);
          classRanks[key] = {
            rank: row.rank_in_exam,
            total: row.total,
            percentile,
            top: percentile >= 90 ? 'top_10' : percentile >= 75 ? 'top_25' : percentile >= 50 ? 'top_half' : 'bottom_half',
          };
        }
      }
    }
    
    const hydratedSubjects = await hydrateCanonicalParts(db, merged.student?.submission_id, merged.term1?.subjects || []);
    merged.term1 = { ...(merged.term1 || {}), subjects: hydratedSubjects };

    return res.status(200).json({ report: merged, classRanks });
  } catch (error) {
    return internalError(res, error, 'student-context');
  }
}
