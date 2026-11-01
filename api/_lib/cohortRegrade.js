import { randomUUID } from 'node:crypto';
import { applyScoringPlan } from '../../apps/processing-worker/scoringPlan.js';
import { findScoreMismatches, loadSubmissionScoring, reportScoreMismatches, syncReportTotals } from '../../apps/processing-worker/submissionScore.js';
import { createAlerter } from '../../shared/alerts.js';
import { feedbackLeaksReasoning } from '../../shared/harshZero.js';
import { resolveSchoolId } from './canonicalSubmissions.js';
import { callJsonModel } from './llmGateway.js';
import { normalizeRecommendations, normalizeStrategies } from '../../shared/reportActionItems.js';
import { guardSubjectClaims, marksByQuestion, scoreDimensionsFromMarks } from '../../shared/reportClaims.js';
import { initialModulesFallback } from '../../apps/processing-worker/workerUtils.js';
import { detectAndStoreEarlyWarning } from './earlyWarning.js';

export const COHORT_REGRADE_WORKFLOW_VERSION = 'cohort-review-v1';

const LEARNING_MODE_IDS = new Set(['architect', 'pathfinder', 'maker', 'cartographer', 'calibrator', 'bridgebuilder']);
const LEARNING_MODE_STATES = new Set(['secure', 'developing', 'needs_practice', 'not_observed']);

export function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export function questionKey(value) {
  return String(value || '').replace(/^Q/i, '').replace(/\s+/g, '').toLowerCase();
}

export function scoreStatus(marks, total, attempted = true) {
  if (!attempted) return 'not_attempted';
  if (Number(marks) >= Number(total)) return 'correct';
  return Number(marks) > 0 ? 'partial' : 'incorrect';
}

function modelPrompt(snapshot, language) {
  const langInstruction = language === 'hindi'
    ? '\nLANGUAGE: Write ALL feedback fields (what_went_correct, needs_attention, next_step, grading_reasoning) in Hindi (Devanagari script). Use Hindi educational terminology.'
    : '';
  return [
    'You write precise, student-facing grading feedback for one reviewed exam question.',
    'The reviewer-approved marks are authoritative. Never change them or challenge them.',
    'Use only the supplied question, rubric, ideal answer, and corrected student evidence.',
    'Be specific about the exact correct work, error, or omission. Do not mention OCR, AI, a reviewer, confidence, or hidden process.',
    'For a full-score response, explain the successful method or idea, not merely that it matched.',
    'For a partial/zero response, name the exact missing or incorrect component and give one concrete next practice action.',
    'Every score explanation must reconcile to the fixed final marks. Do not claim a mark split unless it fully supports that total; when the rubric does not expose a reliable split, describe the correct and missing work without inventing point counts.',
    'Return JSON only: {"what_went_correct":"", "needs_attention":"", "next_step":"", "grading_reasoning":""}. Use an empty string only when a field is genuinely inapplicable. Keep the entire response under 350 words.',
    langInstruction,
    '',
    `Question: ${snapshot.questionText || ''}`,
    `Ideal answer: ${snapshot.correctAnswer || ''}`,
    `Rubric: ${snapshot.markingRubric || ''}`,
    `Corrected student answer: ${snapshot.studentAnswer || 'No answer recorded.'}`,
    `Reviewed evidence source: ${snapshot.evidenceSource || 'ocr_text'}`,
    `Final marks (fixed): ${snapshot.approvedMarks}/${snapshot.marksTotal}`,
  ].join('\n');
}

export async function generateQuestionFeedback(snapshot, language) {
  const feedbackSystem = 'You are an exacting educational feedback writer. Return valid, compact JSON only. Do not use Markdown.';
  const maxTokens = language === 'hindi' ? 1600 : 900;
  const generated = await callJsonModel({
    prompt: modelPrompt(snapshot, language),
    maxTokens,
    system: feedbackSystem,
  });
  const draft = {
    whatWentCorrect: String(generated.result.what_went_correct || '').trim(),
    needsAttention: String(generated.result.needs_attention || '').trim(),
    nextStep: String(generated.result.next_step || '').trim(),
    gradingReasoning: String(generated.result.grading_reasoning || '').trim(),
  };
  // A separate, constrained pass catches the most damaging feedback failure:
  // prose that contradicts reviewer-authoritative marks. It may improve wording
  // but cannot alter the evidence or score supplied below.
  const langAudit = language === 'hindi'
    ? '\nLANGUAGE: Keep ALL feedback fields in Hindi (Devanagari). Do not switch to English.'
    : '';
  const verified = await callJsonModel({
    prompt: [
      'Audit and, if necessary, rewrite this student-facing grading feedback.',
      'The final marks are fixed and authoritative. Do not change them, add evidence, mention review systems, or invent a mark split.',
      'Ensure every numerical claim and the explanation of awarded/lost credit is consistent with the fixed marks. If an exact sub-mark split is not grounded in the rubric, remove the unsupported count.',
      'Return JSON only: {"what_went_correct":"", "needs_attention":"", "next_step":"", "grading_reasoning":""}. Keep it under 350 words.',
      langAudit,
      '',
      `Fixed marks: ${snapshot.approvedMarks}/${snapshot.marksTotal}`,
      `Question: ${snapshot.questionText || ''}`,
      `Rubric: ${snapshot.markingRubric || ''}`,
      `Corrected student answer: ${snapshot.studentAnswer || 'No answer recorded.'}`,
      `Draft feedback: ${JSON.stringify(draft)}`,
    ].join('\n'),
    maxTokens,
    system: feedbackSystem,
  });
  // Neither pass may hand the student the model's own working notes ("I will
  // output the JSON"): use the clean draft, else drop the field.
  const clean = (value, fallback = '') => {
    const candidate = String(value || '').trim();
    return candidate && !feedbackLeaksReasoning(candidate) ? candidate : fallback;
  };
  return {
    whatWentCorrect: clean(verified.result.what_went_correct, clean(draft.whatWentCorrect)),
    needsAttention: clean(verified.result.needs_attention, clean(draft.needsAttention)),
    nextStep: clean(verified.result.next_step, clean(draft.nextStep)),
    gradingReasoning: clean(verified.result.grading_reasoning, clean(draft.gradingReasoning, `${snapshot.approvedMarks}/${snapshot.marksTotal} marks, as confirmed by your teacher.`)),
    model: verified.model || generated.model,
    usage: { generated: generated.usage, verified: verified.usage },
  };
}

function subjectsFor(report) {
  return report.term1?.subjects || report.subjects || [];
}

function findSubject(report, name) {
  return subjectsFor(report).find((item) => String(item.name || item.id || '').toLowerCase() === String(name || '').toLowerCase());
}

function asText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asTextList(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5);
}

function buildSubjectSignal(subject) {
  return {
    name: subject?.name || '',
    score: Number(subject?.score || 0),
    total: Number(subject?.total || 0),
    questions: (subject?.questions || []).map((question) => ({
      id: question.number || question.question_number,
      topic: question.topic || question.section || 'General',
      score: `${Number(question.scored_marks_obtained ?? question.marks_obtained ?? 0)}/${Number(question.scored_marks_allocated ?? question.marks_total ?? 0)}`,
      status: question.status || '',
      feedback: question.missing_or_wrong || question.what_went_correct || question.grading_reason || '',
    })),
  };
}

function sanitizeDna(candidate, previous, questionIds) {
  const base = structuredClone(previous || {});
  const rawDimensions = Array.isArray(candidate?.dimensions) ? candidate.dimensions : [];
  if (!rawDimensions.length) return base;
  const dimensions = rawDimensions
    .filter((item) => LEARNING_MODE_IDS.has(item?.mode_id || item?.id))
    .map((item) => {
      const id = item.mode_id || item.id;
      const evidence = (Array.isArray(item.evidence_question_ids) ? item.evidence_question_ids : [])
        .map(String).filter((value) => questionIds.has(value));
      return {
        id,
        state: LEARNING_MODE_STATES.has(item.state) ? item.state : 'not_observed',
        score: Number.isFinite(Number(item.score)) ? Math.max(0, Math.min(100, Number(item.score))) : null,
        evidence_count: evidence.length,
        evidence_question_ids: evidence,
      };
    });
  if (!dimensions.length) return base;
  return {
    ...base,
    schema_version: 2,
    assessment_scope: { ...(base.assessment_scope || {}), level: 'assessment_snapshot' },
    primary_mode: {
      ...(base.primary_mode || {}),
      mode_id: LEARNING_MODE_IDS.has(candidate?.primary_mode?.mode_id) ? candidate.primary_mode.mode_id : base.primary_mode?.mode_id || null,
      description: asText(candidate?.primary_mode?.description, base.primary_mode?.description),
      evidence: asText(candidate?.primary_mode?.evidence, base.primary_mode?.evidence),
    },
    growth_edge: {
      ...(base.growth_edge || {}),
      mode_id: LEARNING_MODE_IDS.has(candidate?.growth_edge?.mode_id) ? candidate.growth_edge.mode_id : base.growth_edge?.mode_id || null,
      action: asText(candidate?.growth_edge?.action, base.growth_edge?.action),
      evidence: asText(candidate?.growth_edge?.evidence, base.growth_edge?.evidence),
    },
    dimensions,
    next_move: {
      ...(base.next_move || {}),
      title: asText(candidate?.next_move?.title, base.next_move?.title),
      action: asText(candidate?.next_move?.action, base.next_move?.action),
    },
  };
}

/**
 * Only rebuild the subject insight and learner-DNA modules touched by a review
 * run. The marks and reviewed evidence remain fixed inputs; this call cannot
 * alter either of them.
 */
export async function generateStudentReportModules(report, subjectName) {
  const subject = findSubject(report, subjectName);
  if (!subject) return { subject: null, learnerDna: report.learner_dna || null, model: null, refreshed: false };
  const questionIds = new Set((subject.questions || []).map((question) => String(question.number || question.question_number || '')).filter(Boolean));
  const prompt = [
    'Refresh exactly two student-facing report modules after human-reviewed exam corrections.',
    'The revised marks and question feedback below are authoritative. Never alter marks, invent evidence, mention OCR/AI/reviewers, or make personality claims.',
    'Keep the Learner DNA evidence-bound to this assessment. Use only these mode IDs: architect, pathfinder, maker, cartographer, calibrator, bridgebuilder.',
    'Each Learner DNA dimension score is a 0-100 percentage. Rewrite every summary sentence from the revised marks; claim full credit only on questions whose score is full.',
    'Return JSON only with this shape:',
    '{"subject":{"overall_insights":"","strengths":[""],"misconceptions":[""],"recommendations":[{"topic":"","action":"","priority":"important"}],"root_cause":"","learning_profile":{"core_strength":"","pattern_recognition":"","root_cause_analysis":"","strategies":[{"topic":"","strategy":""}]}},"learner_dna":{"primary_mode":{"mode_id":null,"description":"","evidence":""},"growth_edge":{"mode_id":null,"action":"","evidence":""},"dimensions":[{"mode_id":"","state":"","score":0,"evidence_question_ids":[""]}],"next_move":{"title":"","action":""}}}',
    '',
    `Student: ${report.student?.name || 'Student'}`,
    `Affected subject: ${JSON.stringify(buildSubjectSignal(subject))}`,
    `Existing learner DNA: ${JSON.stringify(report.learner_dna || {})}`,
  ].join('\n');
  try {
    const { result, model } = await callJsonModel({
      prompt,
      maxTokens: 1500,
      system: 'You are an exacting educational feedback writer. Return valid, compact JSON only. Do not use Markdown.',
    });
    const currentProfile = subject.learning_profile || {};
    const subjectPatch = result.subject && typeof result.subject === 'object' ? {
      overall_insights: asText(result.subject.overall_insights, subject.overall_insights),
      strengths: asTextList(result.subject.strengths, subject.strengths || []),
      misconceptions: asTextList(result.subject.misconceptions, subject.misconceptions || []),
      recommendations: normalizeRecommendations(result.subject.recommendations, subject.recommendations || []),
      root_cause: asText(result.subject.root_cause, subject.root_cause),
      learning_profile: {
        ...currentProfile,
        core_strength: asText(result.subject.learning_profile?.core_strength, currentProfile.core_strength),
        pattern_recognition: asText(result.subject.learning_profile?.pattern_recognition, currentProfile.pattern_recognition),
        root_cause_analysis: asText(result.subject.learning_profile?.root_cause_analysis, currentProfile.root_cause_analysis),
        strategies: normalizeStrategies(result.subject.learning_profile?.strategies, currentProfile.strategies || []),
      },
    } : null;
    // The reviewed marks are authoritative: no claim or score may contradict them.
    const marks = marksByQuestion(subject.questions || []);
    const fallback = initialModulesFallback(subject.questions || []);
    const learnerDna = sanitizeDna(result.learner_dna, report.learner_dna, questionIds);
    if (Array.isArray(learnerDna?.dimensions)) learnerDna.dimensions = scoreDimensionsFromMarks(learnerDna.dimensions, marks);
    return { subject: guardSubjectClaims(subjectPatch, fallback.subject, marks), learnerDna, model, refreshed: true };
  } catch (error) {
    // A transient narrative-model failure must never discard approved grading.
    return { subject: null, learnerDna: report.learner_dna || null, model: null, refreshed: false, error: error.message };
  }
}

export function buildQuestionSnapshot(row, decision) {
  const payload = parseJson(row.payload_json || row.render_json);
  const question = payload.question || payload;
  const studentAnswer = payload.studentAnswer || {};
  const textAnswer = studentAnswer.studentWrote || question.student_answer || '';
  const visualAnswer = payload.visualReview?.usable ? String(payload.visualReview.visualAnswer || '').trim() : '';
  const textIsPlaceholder = /(?:\[?image placeholders?\]?|\[img-[^\]]+\])/i.test(textAnswer);
  // Visual rescue is already reviewer-visible evidence. Prefer a manually
  // corrected text answer; otherwise use the accepted visual transcription
  // rather than sending an image placeholder back through the feedback model.
  const reviewedAnswer = payload.editedAt || !textIsPlaceholder ? textAnswer : visualAnswer || textAnswer;
  const effectiveMarks = decision?.approved_marks ?? row.approved_marks ?? row.ai_marks ?? question.marks_obtained ?? 0;
  return {
    questionId: row.id,
    submissionId: row.submission_id,
    questionNumber: row.question_number,
    subject: row.subject,
    studentName: row.student_name,
    questionText: payload.questionText || question.question_text || row.question_text || '',
    correctAnswer: payload.correctAnswer || question.correct_answer || row.answer_key_text || '',
    markingRubric: payload.markingRubric || question.marking_rubric || parseJson(row.rubric_json, {}).text || '',
    studentAnswer: reviewedAnswer,
    evidenceSource: payload.editedAt ? 'reviewer_text' : visualAnswer && (textIsPlaceholder || !textAnswer) ? 'accepted_visual_evidence' : 'ocr_text',
    attempted: studentAnswer.attempted ?? question.status !== 'not_attempted',
    approvedMarks: Number(effectiveMarks),
    marksTotal: Number(row.marks_total ?? payload.marksAllocated ?? question.marks_total ?? 0),
    payload,
  };
}

export function applyFeedbackToQuestion(snapshot, feedback, regradeRunId, revision) {
  const next = structuredClone(snapshot.payload || {});
  const question = next.question || next;
  const status = scoreStatus(snapshot.approvedMarks, snapshot.marksTotal, snapshot.attempted);
  const grade = {
    ...(next.grade || {}),
    marks: snapshot.approvedMarks,
    allocated: snapshot.marksTotal,
    status,
    confidence: 'high',
  };
  const rationale = {
    whatWentCorrect: feedback.whatWentCorrect,
    missingOrWrong: feedback.needsAttention,
    reasoning: feedback.gradingReasoning,
    nextStep: feedback.nextStep,
  };
  const studentAnswer = { ...(next.studentAnswer || {}), attempted: snapshot.attempted };
  next.grade = grade;
  next.gradeRationale = rationale;
  next.studentAnswer = studentAnswer;
  next.regrade = { runId: regradeRunId, revision, model: feedback.model, regradedAt: new Date().toISOString() };
  question.marks_obtained = snapshot.approvedMarks;
  question.marks_total = snapshot.marksTotal;
  question.status = status;
  question.student_answer = snapshot.studentAnswer;
  question.what_went_correct = feedback.whatWentCorrect;
  question.missing_or_wrong = feedback.needsAttention;
  question.grading_reason = feedback.gradingReasoning;
  question.next_step = feedback.nextStep;
  return next;
}

/** Sum published subject score/total — matches student report and teacher getReportScore. */
export function reportAssessmentTotals(report) {
  const subjects = report?.term1?.subjects || report?.subjects || [];
  let score = 0;
  let total = 0;
  for (const subject of subjects) {
    score += Number(subject.score) || 0;
    total += Number(subject.total) || 0;
  }
  return { score, total };
}

export function applyFeedbackToReport(report, questionRow, snapshot, feedback) {
  const next = structuredClone(report);
  const subjects = next.term1?.subjects || next.subjects || [];
  const subject = subjects.find((item) => String(item.name || item.id || '').toLowerCase() === String(questionRow.subject || '').toLowerCase());
  if (!subject) return next;
  const target = (subject.questions || []).find((item) => questionKey(item.number || item.question_number) === questionKey(questionRow.question_number));
  if (!target) return next;
  const status = scoreStatus(snapshot.approvedMarks, snapshot.marksTotal, snapshot.attempted);
  Object.assign(target, {
    marks_obtained: snapshot.approvedMarks,
    scored_marks_obtained: snapshot.approvedMarks,
    marks_total: snapshot.marksTotal,
    scored_marks_allocated: snapshot.marksTotal,
    status,
    student_answer_raw: snapshot.studentAnswer,
    what_went_correct: feedback.whatWentCorrect,
    missing_or_wrong: feedback.needsAttention,
    turning_point: feedback.nextStep || feedback.needsAttention || feedback.whatWentCorrect,
    thinking_trace: feedback.gradingReasoning,
    grading_reason: feedback.gradingReasoning,
    next_step: feedback.nextStep,
  });
  const scoring = applyScoringPlan(subject.questions || [], subject.scoring_plan);
  subject.questions = scoring.questions;
  subject.score = scoring.score;
  subject.total = scoring.total;
  subject.scoring_notes = scoring.notes;
  return next;
}

function applyStudentReportModules(report, subjectName, modules, runId, sourceRevision) {
  const next = structuredClone(report);
  const subject = findSubject(next, subjectName);
  if (subject && modules.subject) Object.assign(subject, modules.subject);
  if (modules.learnerDna) next.learner_dna = modules.learnerDna;
  next.workflow = {
    ...(next.workflow || {}),
    modules: {
      ...((next.workflow || {}).modules || {}),
      [`subject:${subjectName}`]: { version: sourceRevision, run_id: runId, refreshed_at: new Date().toISOString(), status: modules.refreshed ? 'refreshed' : 'preserved' },
      learner_dna: { version: sourceRevision, run_id: runId, refreshed_at: new Date().toISOString(), status: modules.refreshed ? 'refreshed' : 'preserved' },
    },
  };
  return next;
}

// Each row is written only if its report version was (see publishOnLatestReport).
function moduleRows(reportId, updates, subjectName, modules, runId, now) {
  const maxRevision = Math.max(...updates.map((update) => Number(update.question.revision || update.snapshot.reviewRevision || 0)), 0);
  const rows = updates.map((update) => ({
    sql: `INSERT INTO report_modules (id, report_version_id, submission_question_id, module_type, module_key, source_revision, dependency_json, payload_json, status, created_at)
          SELECT ?, ?, ?, 'question_feedback', ?, ?, ?, ?, 'published', ?
          WHERE EXISTS (SELECT 1 FROM report_versions WHERE id = ?)`,
    args: [
      `report_module_${randomUUID()}`,
      reportId,
      update.question.submission_question_id,
      `question:${update.question.question_number}`,
      Number(update.question.revision || update.snapshot.reviewRevision || 0),
      JSON.stringify({ run_id: runId, question_revision: Number(update.question.revision || update.snapshot.reviewRevision || 0) }),
      JSON.stringify(update.feedback),
      now,
      reportId,
    ],
  }));
  rows.push({
    sql: `INSERT INTO report_modules (id, report_version_id, module_type, module_key, source_revision, dependency_json, payload_json, status, created_at)
          SELECT ?, ?, 'subject_insight', ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM report_versions WHERE id = ?)`,
    args: [
      `report_module_${randomUUID()}`,
      reportId,
      `subject:${subjectName}`,
      maxRevision,
      JSON.stringify({ run_id: runId, question_count: updates.length, questions: updates.map((update) => update.question.question_number) }),
      JSON.stringify(modules.subject || {}),
      modules.refreshed ? 'published' : 'preserved',
      now,
      reportId,
    ],
  });
  rows.push({
    sql: `INSERT INTO report_modules (id, report_version_id, module_type, module_key, source_revision, dependency_json, payload_json, status, created_at)
          SELECT ?, ?, 'learner_dna', 'learner_dna', ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM report_versions WHERE id = ?)`,
    args: [
      `report_module_${randomUUID()}`,
      reportId,
      maxRevision,
      JSON.stringify({ run_id: runId, affected_subject: subjectName, question_count: updates.length }),
      JSON.stringify(modules.learnerDna || {}),
      modules.refreshed ? 'published' : 'preserved',
      now,
      reportId,
    ],
  });
  return rows;
}

const defaultAlerts = createAlerter();

// With a reportId, each write lands only if that report row was inserted, so a
// publisher that lost the race writes no score either.
function submissionScoreStatements(submissionId, { score, total }, now, reportId = null) {
  const guard = reportId ? ' AND EXISTS (SELECT 1 FROM report_versions WHERE id = ?)' : '';
  const extra = reportId ? [reportId] : [];
  return [
    { sql: `UPDATE submissions SET score = ?, max_marks = ?, updated_at = ? WHERE id = ?${guard}`, args: [score, total, now, submissionId, ...extra] },
    { sql: `UPDATE test_submissions SET score = ?, max_marks = ?, updated_at = ? WHERE id = ?${guard}`, args: [score, total, now, submissionId, ...extra] },
  ];
}

async function checkRegradedScore(db, submissionId, live, expected, source, alerts) {
  const mismatches = await findScoreMismatches(db, submissionId, expected).catch(() => []);
  await reportScoreMismatches({ alerts, school: live.submission.school, testId: live.submission.test_id, source, items: [{ submissionId, expected, mismatches }] });
}

/**
 * Re-totals a submission that has no published report (held by a report
 * guardrail): there is no report to patch, but its stored score must still
 * follow the regraded marks.
 */
export async function retotalSubmissionScore(db, submissionId, { alerts = defaultAlerts } = {}) {
  const live = await loadSubmissionScoring(db, submissionId);
  if (!live || !(live.scoring.total > 0)) return null;
  const expected = { score: live.scoring.score, total: live.scoring.total };
  const now = new Date().toISOString();
  await db.batch([
    ...submissionScoreStatements(submissionId, expected, now),
    { sql: 'UPDATE cohort_report_cache SET invalidated_at = ? WHERE exam_id = (SELECT exam_id FROM submissions WHERE id = ?) AND invalidated_at IS NULL', args: [now, submissionId] },
  ], 'write');
  await checkRegradedScore(db, submissionId, live, expected, 'cohort_regrade_held', alerts);
  return expected;
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''));
}

// One attempt at publishing `updates` on top of the latest published report.
// Returns null when there is no published report, `{ lost: true }` when another
// publisher superseded that report first (nothing was written), else the result.
async function publishOnLatestReport(db, submissionId, updates, runId) {
  // Allocate the next version from the full history: superseded versions are
  // kept for audit and can sit above the published one.
  const latest = await db.execute({
    sql: `SELECT id, version, payload_json, username, school,
                 (SELECT MAX(version) FROM report_versions WHERE submission_id = ?) AS max_version
          FROM report_versions
          WHERE submission_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1`,
    args: [submissionId, submissionId],
  });
  if (!latest.rows.length) return null;
  const previous = latest.rows[0];
  let report = parseJson(previous.payload_json);
  for (const update of updates) report = applyFeedbackToReport(report, update.question, update.snapshot, update.feedback);
  const subjectName = updates[0]?.question?.subject;
  // Re-total from the live question marks and the active rubric's choice rules
  // rather than the stored report totals, which skip questions the patch could
  // not match, carry forward earlier totals and may predate the scoring plan.
  const subjects = report.term1?.subjects || report.subjects || [];
  const storedPlan = (subjects.find((item) => String(item.name || item.id || '').toLowerCase() === String(subjectName || '').toLowerCase()) || subjects[0])?.scoring_plan || null;
  const live = await loadSubmissionScoring(db, submissionId, { fallbackPlan: storedPlan });
  const liveTotals = live && live.scoring.total > 0 ? { score: live.scoring.score, total: live.scoring.total } : null;
  if (liveTotals) report = syncReportTotals(report, live, subjectName).report;
  const modules = await generateStudentReportModules(report, subjectName);
  const sourceRevision = Math.max(...updates.map((update) => Number(update.question.revision || update.snapshot.reviewRevision || 0)), 0);
  report = applyStudentReportModules(report, subjectName, modules, runId, sourceRevision);
  report.workflow = { ...(report.workflow || {}), last_cohort_regrade_run_id: runId, updated_at: new Date().toISOString() };
  const { score: reportScore, total: reportTotal } = reportAssessmentTotals(report);
  const version = Math.max(Number(previous.version), Number(previous.max_version || 0)) + 1;
  const reportId = `report_${randomUUID()}`;
  const now = new Date().toISOString();
  const totals = liveTotals || (reportTotal > 0 ? { score: reportScore, total: reportTotal } : null);
  // Every write after the supersede is conditional on the new report row, so a
  // publisher that lost the race to supersede `previous` writes nothing at all.
  const submissionScoreOps = totals ? submissionScoreStatements(submissionId, totals, now, reportId) : [];
  const results = await db.batch([
    { sql: "UPDATE report_versions SET status = 'superseded', superseded_at = ? WHERE id = ? AND status = 'published'", args: [now, previous.id] },
    { sql: `INSERT INTO report_versions (id, submission_id, version, status, workflow_run_id, generated_at, published_at, payload_json, username, school, exam_id, student_id)
            SELECT ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?,
                   (SELECT exam_id FROM submissions WHERE id = ?), (SELECT student_id FROM submissions WHERE id = ?)
            WHERE changes() = 1`,
      args: [reportId, submissionId, version, runId, now, now, JSON.stringify(report), previous.username, previous.school, submissionId, submissionId] },
    ...moduleRows(reportId, updates, subjectName, modules, runId, now),
    ...submissionScoreOps,
  ], 'write');
  if (Number(results?.[0]?.rowsAffected || 0) !== 1 || Number(results?.[1]?.rowsAffected || 0) !== 1) return { lost: true };
  return { previous, report, modules, reportId, version, now, live, totals };
}

export async function publishSubmissionReport(db, submissionId, updates, runId, { alerts = defaultAlerts } = {}) {
  // The item's grade writes are already committed when this runs, so a lost
  // race with another publisher (superseded report or a version collision)
  // retries once on the new latest report instead of failing the item.
  let published = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      published = await publishOnLatestReport(db, submissionId, updates, runId);
    } catch (error) {
      if (attempt === 0 && isUniqueViolation(error)) continue;
      throw error;
    }
    if (!published?.lost) break;
    if (attempt === 1) throw new Error('The report changed while it was being published; retry the regrade.');
  }
  if (!published) return null;
  const { previous, report, modules, reportId, version, now, live, totals } = published;
  if (live && totals) await checkRegradedScore(db, submissionId, live, totals, 'cohort_regrade', alerts);

  const identity = await db.execute({
    sql: `SELECT s.student_id, s.exam_id, e.school_id, st.display_name AS student_name
          FROM submissions s
          LEFT JOIN exams e ON e.id = s.exam_id
          LEFT JOIN students st ON st.id = s.student_id
          WHERE s.id = ?
          LIMIT 1`,
    args: [submissionId],
  }).catch(() => ({ rows: [] }));
  const row = identity.rows[0];
  const warningSchoolId = row?.school_id || await resolveSchoolId(db, previous.school).catch(() => null);
  if (warningSchoolId && row?.student_id) {
    await detectAndStoreEarlyWarning(db, {
      schoolId: warningSchoolId,
      studentId: row.student_id,
      examId: row.exam_id || null,
      submissionId,
      username: previous.username,
      studentName: row.student_name || previous.username,
      report,
      at: now,
    }).catch(() => null);
  }

  return { reportId, version, username: previous.username, modules: { subject: Boolean(modules.subject), learnerDna: Boolean(modules.learnerDna), refreshed: modules.refreshed } };
}

function normalizedSubject(value) {
  return String(value || '').toLowerCase().replace('mathematics', 'maths').replace(/[^a-z0-9]/g, '');
}

/** Phase 5: teacher dashboards read live canonical aggregates from
 * cohort_report_cache. A publish/regrade invalidates the affected exams'
 * cached payloads so the next dashboard read recomputes from
 * submissions/report_versions instead of legacy teacher payload blobs. */
export async function refreshTeacherReportModules(db, run) {
  // regrade_runs stores school/subject inside the scope JSON (and school_id
  // directly); older callers passed flat run.school/run.subject rows.
  let scope = {};
  try { scope = JSON.parse(run.scope || '{}'); } catch { scope = {}; }
  // Database errors propagate: a swallowed read used to skip invalidation
  // while the caller recorded the teacher modules as refreshed.
  const schoolId = run.school_id || await resolveSchoolId(db, scope.school || run.school);
  if (!schoolId) return { updated: 0, studentCount: 0 };
  const targetSubject = normalizedSubject(scope.subject || run.subject);
  const exams = await db.execute({
    sql: 'SELECT e.id, sub.name AS subject FROM exams e LEFT JOIN subjects sub ON sub.id = e.subject_id WHERE e.school_id = ?',
    args: [schoolId],
  });
  const targets = exams.rows.filter((row) => !targetSubject || targetSubject === 'all' || normalizedSubject(row.subject) === targetSubject);
  if (!targets.length) return { updated: 0, studentCount: 0 };
  const now = new Date().toISOString();
  await db.batch(targets.map((row) => ({
    sql: 'UPDATE cohort_report_cache SET invalidated_at = ? WHERE exam_id = ? AND invalidated_at IS NULL',
    args: [now, row.id],
  })), 'write');
  return { updated: targets.length, studentCount: 0 };
}
