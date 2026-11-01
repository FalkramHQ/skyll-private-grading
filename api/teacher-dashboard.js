import { database, ensureAuthTables, requireUser } from './_lib/auth.js';
import { internalError } from './_lib/httpError.js';

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function performanceBand(percentage) {
  if (percentage >= 75) return 'quadrant_a';
  if (percentage >= 45) return 'quadrant_b';
  if (percentage >= 35) return 'quadrant_c';
  return 'quadrant_d';
}

// Stored question numbers are already "Q4"; never prefix another Q.
function questionLabel(number) {
  return `Q${String(number ?? '').trim().replace(/^Q/i, '')}`;
}

/** Class average per rubric topic, weakest first, from the reviewed marks.
 * Each topic covers every scored answer to its questions (a blank scores 0).
 * Returns null when the query fails, like buildExamHotspots. */
export async function buildTopicGaps(db, testId) {
  if (!testId) return [];
  try {
    const result = await db.execute({
      sql: `SELECT q.question_number, json_extract(esq.rubric_json, '$.topic') AS topic,
              CAST(esq.max_marks AS REAL) AS max_marks,
              CAST(COALESCE(q.approved_marks, q.ai_marks, 0) AS REAL) AS marks
            FROM submission_questions_v2 q
            JOIN submissions s ON s.id = q.submission_id
            JOIN exams e ON e.id = s.exam_id
            JOIN exam_set_questions esq ON esq.id = q.exam_set_question_id
            WHERE e.source_test_id = ? AND esq.max_marks > 0`,
      args: [testId],
    });
    return topicGapsFromRows(result.rows);
  } catch (error) {
    console.warn('[teacher-dashboard] topic gaps failed:', testId, error?.message || error);
    return null;
  }
}

export function topicGapsFromRows(rows) {
  const topics = new Map();
  for (const row of rows) {
    const title = String(row.topic || '').trim();
    if (!title) continue;
    const entry = topics.get(title) || { title, marks: 0, max: 0, questions: new Set() };
    entry.marks += Number(row.marks) || 0;
    entry.max += Number(row.max_marks) || 0;
    entry.questions.add(questionLabel(row.question_number));
    topics.set(title, entry);
  }
  return [...topics.values()]
    .filter((entry) => entry.max > 0)
    .map((entry) => ({
      title: entry.title,
      avg: Math.round((entry.marks / entry.max) * 100),
      description: `Questions ${[...entry.questions].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join(', ')}.`,
    }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 5);
}

/** Build per-question hotspots from canonical v2 + exam set questions.
 * Returns null when the query fails, so the caller can tell a failure apart
 * from an exam that simply has no hotspots yet. */
async function buildExamHotspots(db, testId) {
  if (!testId) return [];
  try {
    const result = await db.execute({
      sql: `SELECT q.question_number, esq.question_text, COUNT(*) as attempted,
              SUM(CASE WHEN COALESCE(q.approved_marks, q.ai_marks) = 0 THEN 1 ELSE 0 END) as zero_count,
              ROUND(AVG(CAST(COALESCE(q.approved_marks, q.ai_marks) AS REAL) / NULLIF(CAST(esq.max_marks AS REAL), 0)) * 100) as avg_pct
            FROM submission_questions_v2 q
            JOIN submissions s ON s.id = q.submission_id
            JOIN exams e ON e.id = s.exam_id
            LEFT JOIN exam_set_questions esq ON esq.id = q.exam_set_question_id
            WHERE e.source_test_id = ? AND q.status != 'not_attempted'
            GROUP BY q.question_number
            HAVING attempted >= 2
            ORDER BY avg_pct ASC
            LIMIT 5`,
      args: [testId],
    });
    if (!result.rows.length) return [];
    return result.rows.map((r) => {
      const failRate = Math.round(100 - (Number(r.avg_pct) || 0));
      const zeroCount = Number(r.zero_count) || 0;
      const attempted = Number(r.attempted) || 0;
      const qText = (r.question_text || '').slice(0, 120);
      return {
        id: questionLabel(r.question_number),
        title: qText || `Question ${String(r.question_number).replace(/^Q/i, '')}`,
        failure_rate: `${failRate}% struggled`,
        why: zeroCount === attempted
          ? `All ${attempted} student(s) who attempted this scored zero.`
          : `${zeroCount} of ${attempted} students scored zero; average score only ${Number(r.avg_pct) || 0}%.`,
        implication: failRate >= 80
          ? 'This topic needs full re-teaching before moving forward.'
          : failRate >= 50
          ? 'Revisit this concept with targeted practice problems.'
          : 'A few students need individual support on this question.',
      };
    });
  } catch (error) {
    console.warn('[teacher-dashboard] exam hotspots failed:', testId, error?.message || error);
    return null;
  }
}

// cohort_report_cache rows are read in chunks of this many exam ids, and at
// most this many uncached cohorts are recomputed at once.
const CACHE_READ_CHUNK = 200;
const COHORT_BUILD_CONCURRENCY = 4;

/* The cache is only explicitly invalidated by cohort regrades and offline
 * scripts, so each entry also records the submissions it was built from: the
 * count of live submissions and their latest updated_at. Grading, report
 * builds and regrades all bump submissions.updated_at, so a mismatch means the
 * exam moved on since the payload was computed. */
function sourceWatermark(submissions) {
  let latest = '';
  for (const row of submissions) {
    const updatedAt = String(row.updated_at || '');
    if (updatedAt > latest) latest = updatedAt;
  }
  return `${submissions.length}|${latest}`;
}

/** Map with at most `limit` calls in flight; results keep input order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loadCachedCohorts(db, schoolId, examIds) {
  const cached = new Map();
  for (let start = 0; start < examIds.length; start += CACHE_READ_CHUNK) {
    const chunk = examIds.slice(start, start + CACHE_READ_CHUNK);
    const result = await db.execute({
      sql: `SELECT exam_id, payload_json FROM cohort_report_cache
            WHERE school_id = ? AND invalidated_at IS NULL AND exam_id IN (${chunk.map(() => '?').join(', ')})`,
      args: [schoolId, ...chunk],
    });
    for (const row of result.rows) cached.set(row.exam_id, parseJson(row.payload_json, null));
  }
  return cached;
}

function canonicalCohort(test, submissions) {
  const scored = submissions.filter((row) => Number(row.max_marks) > 0);
  const segments = { quadrant_a: [], quadrant_b: [], quadrant_c: [], quadrant_d: [] };
  for (const row of scored) {
    const percentage = Math.round((Number(row.score || 0) / Number(row.max_marks)) * 100);
    segments[performanceBand(percentage)].push(row.student_name || row.student_id);
  }
  const count = scored.length;
  const averageScore = count ? Math.round((scored.reduce((sum, row) => sum + Number(row.score || 0), 0) / count) * 100) / 100 : 0;
  const averageTotal = count ? Math.round((scored.reduce((sum, row) => sum + Number(row.max_marks || 0), 0) / count) * 100) / 100 : 0;
  const averagePercentage = count ? Math.round(scored.reduce((sum, row) => sum + ((Number(row.score || 0) / Number(row.max_marks)) * 100), 0) / count) : 0;
  return {
    assessment: { test_id: test.id, title: test.title || 'Untitled assessment', subject: test.subject, grade: test.grade },
    overview: { evaluated_students: count, average_score: averageScore, average_total: averageTotal, average_percentage: averagePercentage },
    segmentation: segments,
    systemic_strengths: segments.quadrant_a.length ? [`${segments.quadrant_a.length} learner(s) are currently in the strong-performance band for this assessment.`] : [],
    systemic_gaps: segments.quadrant_d.length ? [`${segments.quadrant_d.length} learner(s) need focused support before the next assessment.`] : [],
    exam_hotspots: [], // populated async after creation
    interventions: [
      { type: 'immediate', title: 'Triage the needs-work group', action: 'Use each student report to assign one targeted correction task before broad revision.' },
      { type: 'long-term', title: 'Track the next assessment', action: 'Compare the same learners after the next test to verify whether targeted practice improved transfer.' },
    ],
  };
}

/* Cached cohort payloads store the deterministic aggregate; the narrative
 * bands are derived from the same numbers, so reattach them on cache hits. */
function withNarrative(cohort) {
  if (!cohort || typeof cohort !== 'object') return cohort;
  const strong = cohort.segmentation?.quadrant_a?.length || 0;
  const needsWork = cohort.segmentation?.quadrant_d?.length || 0;
  return {
    ...cohort,
    systemic_strengths: strong ? [`${strong} learner(s) are currently in the strong-performance band for this assessment.`] : [],
    systemic_gaps: needsWork ? [`${needsWork} learner(s) need focused support before the next assessment.`] : [],
    exam_hotspots: cohort.exam_hotspots || [], // populated from cached payload
    interventions: [
      { type: 'immediate', title: 'Triage the needs-work group', action: 'Use each student report to assign one targeted correction task before broad revision.' },
      { type: 'long-term', title: 'Track the next assessment', action: 'Compare the same learners after the next test to verify whether targeted practice improved transfer.' },
    ],
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['teacher', 'admin', 'skyll_admin']);
    if (!user) return;
    const db = database();
    // Phase 5: the dashboard reads live from exams/submissions/report_versions
    // (+ cohort_report_cache). Legacy teacher payload blobs are no longer read.
    const school = user.school;
    // Tenancy is the school pinned on the session; resolving it from the
    // display name could land on another school with a similar name (FLKRM-385).
    const schoolId = user.school_id || null;
    if (!schoolId) return res.status(404).json({ error: 'School not found' });
    // Resolve academic years for this school
    const academicYearsResult = await db.execute({
      sql: `SELECT id, label, is_current FROM academic_years WHERE school_id = ? ORDER BY label DESC`,
      args: [schoolId],
    });
    const academicYears = academicYearsResult.rows.map((r) => ({ id: r.id, label: r.label, is_current: Number(r.is_current) === 1 }));
    const requestedYear = req.query.year || '';
    const yearFilter = requestedYear === 'all' ? null : (requestedYear || academicYears.find((y) => y.is_current)?.id || null);
    const requestedExamId = req.query.exam_id ? String(req.query.exam_id).trim() : null;

    const [examsResult, submissionsResult, reportsResult] = await Promise.all([
      // Teacher dash is for reviewing graded work — hide upload/collecting exams
      // with no submissions yet (they still live on intake until processing starts).
      db.execute({ sql: `SELECT e.id, e.source_test_id, e.name, e.exam_date, e.exam_type, e.grade AS exam_grade, e.academic_year_id,
                                sub.name AS subject, t.grade, ay.label AS academic_year
                        FROM exams e
                        LEFT JOIN subjects sub ON sub.id = e.subject_id
                        LEFT JOIN tests t ON t.id = e.source_test_id
                        LEFT JOIN academic_years ay ON ay.id = e.academic_year_id
                        WHERE e.school_id = ? AND e.status NOT IN ('archived', 'held')
                        AND EXISTS (
                          SELECT 1 FROM submissions s
                          WHERE s.exam_id = e.id AND s.status != 'archived'
                        )
                        ${requestedExamId ? 'AND COALESCE(e.source_test_id, e.id) = ?' : ''}
                        ${yearFilter ? 'AND (e.academic_year_id = ? OR e.academic_year_id IS NULL)' : ''}
                        ORDER BY COALESCE(e.exam_date, e.created_at) DESC`,
      args: [
        schoolId,
        ...(requestedExamId ? [requestedExamId] : []),
        ...(yearFilter ? [yearFilter] : []),
      ] }),
      // Same exam and academic-year predicates as the exam list, so the overview
      // averages only the exams the teacher can see.
      db.execute({ sql: `SELECT s.id, s.exam_id, s.student_id, s.score, s.max_marks, s.updated_at,
                                COALESCE(st.display_name, ts.student_name, s.student_id) AS student_name
                        FROM submissions s
                        JOIN exams e ON e.id = s.exam_id
                        LEFT JOIN students st ON st.id = s.student_id
                        LEFT JOIN test_students ts ON ts.test_id = e.source_test_id AND ts.student_id = s.student_id
                        WHERE e.school_id = ? AND s.status != 'archived' AND e.status NOT IN ('archived', 'held')
                        ${requestedExamId ? 'AND COALESCE(e.source_test_id, e.id) = ?' : ''}
                        ${yearFilter ? 'AND (e.academic_year_id = ? OR e.academic_year_id IS NULL)' : ''}`,
      args: [
        schoolId,
        ...(requestedExamId ? [requestedExamId] : []),
        ...(yearFilter ? [yearFilter] : []),
      ] }),
      // Prefer indexed exam/submission joins and skip bulky payload_json for the
      // student list. Full report blobs (~80KB×N) were freezing PartnerB Mid term.
      requestedExamId ? db.execute({ sql: `SELECT rv.submission_id, rv.username,
                                s.score, s.max_marks,
                                COALESCE(st.display_name, ts.student_name, s.student_id) AS student_name,
                                COALESCE(e.grade, t.grade) AS student_class,
                                COALESCE(sub.name, t.subject, 'Subject') AS subject_name,
                                COALESCE(e.source_test_id, e.id) AS test_id
                        FROM report_versions rv
                        JOIN submissions s ON s.id = rv.submission_id
                        JOIN exams e ON e.id = s.exam_id
                        LEFT JOIN tests t ON t.id = e.source_test_id
                        LEFT JOIN subjects sub ON sub.id = e.subject_id
                        LEFT JOIN students st ON st.id = s.student_id
                        LEFT JOIN test_students ts ON ts.test_id = e.source_test_id AND ts.student_id = s.student_id
                        WHERE e.school_id = ?
                          AND rv.status = 'published'
                          AND s.status != 'archived'
                          AND e.status NOT IN ('archived', 'held')
                          AND COALESCE(e.source_test_id, e.id) = ?
                        ORDER BY rv.generated_at DESC`, args: [schoolId, requestedExamId] }) : Promise.resolve({ rows: [] }),
    ]);
    const reportsBySubmission = new Map();
    for (const row of reportsResult.rows) {
      if (reportsBySubmission.has(row.submission_id)) continue;
      const score = Number(row.score) || 0;
      const total = Number(row.max_marks) || 0;
      const subjectName = row.subject_name || 'Subject';
      reportsBySubmission.set(row.submission_id, {
        username: row.username,
        test_id: row.test_id,
        student: {
          name: row.student_name || row.username,
          class: row.student_class || '',
        },
        term1: {
          subjects: [{
            name: subjectName,
            score,
            total,
          }],
        },
      });
    }
    const studentReports = [...reportsBySubmission.values()];
    const submissionsByExam = new Map();
    for (const row of submissionsResult.rows) {
      if (!submissionsByExam.has(row.exam_id)) submissionsByExam.set(row.exam_id, []);
      submissionsByExam.get(row.exam_id).push(row);
    }
    const cohortExams = examsResult.rows.filter((exam) => submissionsByExam.has(exam.id));
    const cachedCohorts = await loadCachedCohorts(db, schoolId, cohortExams.map((exam) => exam.id));
    const cohorts = await mapWithConcurrency(cohortExams, COHORT_BUILD_CONCURRENCY, async (exam) => {
      const examSubmissions = submissionsByExam.get(exam.id);
      const test = { id: exam.source_test_id || exam.id, title: exam.name, subject: exam.subject, grade: exam.grade };
      const watermark = sourceWatermark(examSubmissions);
      const cached = cachedCohorts.get(exam.id);
      // Entries cached before topic gaps existed are rebuilt once.
      if (cached && cached.source_watermark === watermark && Array.isArray(cached.topic_gaps)) {
        const { source_watermark: _watermark, ...payload } = cached;
        return [test.id, withNarrative(payload)];
      }
      const cohort = canonicalCohort(test, examSubmissions);
      const [hotspots, topicGaps] = await Promise.all([buildExamHotspots(db, test.id), buildTopicGaps(db, test.id)]);
      if (hotspots?.length) cohort.exam_hotspots = hotspots;
      cohort.topic_gaps = topicGaps || [];
      // A failed hotspot or topic query is served once but never cached, so
      // the next read retries instead of freezing an empty list.
      if (hotspots && topicGaps) {
        await db.execute({
          sql: `INSERT INTO cohort_report_cache (exam_id, school_id, payload_json, computed_at, invalidated_at)
                VALUES (?, ?, ?, ?, NULL)
                ON CONFLICT(exam_id) DO UPDATE SET
                  school_id = excluded.school_id, payload_json = excluded.payload_json,
                  computed_at = excluded.computed_at, invalidated_at = NULL`,
          args: [exam.id, schoolId, JSON.stringify({ ...cohort, source_watermark: watermark }), new Date().toISOString()],
        }).catch((error) => console.warn('[teacher-dashboard] cohort cache write failed:', exam.id, error?.message || error));
      }
      return [test.id, cohort];
    });
    const cohortReports = Object.fromEntries(cohorts);
    const scored = submissionsResult.rows.filter((row) => Number(row.max_marks) > 0);
    const averagePercentage = scored.length
      ? Math.round(scored.reduce((sum, row) => sum + (Number(row.score || 0) / Number(row.max_marks)) * 100, 0) / scored.length)
      : 0;
    const report = {
      school,
      subject: 'All',
      cohort_report: {
        overview: {
          date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
          evaluated_students: scored.length,
          average_performance: `${averagePercentage}%`,
        },
      },
      cohort_reports: cohortReports,
      workflow: { source: 'canonical_live' },
    };
    const exams = examsResult.rows.map((e) => ({
      id: e.id,
      name: e.name,
      exam_date: e.exam_date,
      exam_type: e.exam_type || 'subjective',
      subject: e.subject || null,
      grade: e.exam_grade || e.grade || null,
      academic_year: e.academic_year || null,
      academic_year_id: e.academic_year_id || null,
      source_test_id: e.source_test_id,
    }));
    // Resolve short login aliases for student reports
    try {
      const aliasResult = await db.execute({
        sql: `SELECT uc.login_id, sul.student_id FROM user_credentials uc
              JOIN student_user_links sul ON sul.user_id = uc.user_id
              WHERE sul.school_id = ? AND uc.login_id NOT LIKE 'partnerb_%' AND uc.login_id NOT LIKE 'intake_%'`,
        args: [schoolId],
      });
      // Map long login_id → short alias via shared student_id
      const allCreds = await db.execute({
        sql: `SELECT uc.login_id, sul.student_id FROM user_credentials uc
              JOIN student_user_links sul ON sul.user_id = uc.user_id
              WHERE sul.school_id = ?`,
        args: [schoolId],
      });
      const studentToShort = new Map();
      for (const row of aliasResult.rows) studentToShort.set(row.student_id, row.login_id);
      const longToShort = new Map();
      for (const row of allCreds.rows) {
        const short = studentToShort.get(row.student_id);
        if (short && row.login_id !== short) longToShort.set(row.login_id, short);
      }
      for (const report of studentReports) {
        if (report.username && longToShort.has(report.username)) {
          report.public_username = longToShort.get(report.username);
        }
      }
    } catch { /* non-critical */ }
    return res.status(200).json({ report, studentReports, exams, academic_years: academicYears });
  } catch (error) {
    return internalError(res, error, 'teacher-dashboard');
  }
}
