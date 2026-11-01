/**
 * Grade Supervisor — after normalizeGradeResult: letter-by-letter marking for MCQ
 * blocks, an optional downward recheck (off unless a subject profile opts in),
 * and one re-mark when the reasoning states a higher total than the mark, which
 * may raise or lower it. The 0.5 idea-credit bump is gone from every mode.
 */

import {
  isSubjectiveResponseType,
  mergeReviewTags,
  normalizeCriteria,
  parseRubricCriteria,
} from '../../shared/harshZero.js';
import { buildGradePrompt, normalizeGradeResult } from './gradeResult.js';
import { gradingResponseType } from '../../shared/rubricGate.js';
import { markMcqBlock, mcqBlockGradeJson } from '../../shared/mcqBlock.js';
import { downwardRecheckEnabled } from '../../shared/gradingProfiles/index.js';
import {
  DUPLICATE_EVIDENCE_TAG,
  MARKS_INCONSISTENT_TAG,
  STATED_ERROR_TAG,
  buildDownwardRepairPrompt,
  gradingCalibrationModeFor,
  namesError,
  subjectGradingRules,
} from '../../shared/gradingCalibration.js';

const roundMarks = (value) => Math.round(Number(value) * 100) / 100;

function subjectiveType(responseType) {
  const type = String(responseType || '').toLowerCase();
  return isSubjectiveResponseType(type) && !['mcq', 'numerical', 'diagram', 'table'].includes(type);
}

/**
 * Pull an explicit mark claim out of grading prose ("Total 1 mark", "earns 2 marks").
 * Used to catch Sanika-style contradictions where reasoning awards marks but marks_awarded is 0.
 */
export function extractClaimedMarks(reasoning = '', max = null) {
  const text = String(reasoning || '');
  // The grader's final total against the question's marks: the last "X out of N"
  // or "X/N" with N the question's marks. "Total = 2 + 2 + 2 = 6 out of 10" is 6,
  // never the first 2 (which made a 6/10 grade read as claiming 2).
  if (Number(max) > 0) {
    let last = null;
    const outOf = /(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*(\d+(?:\.\d+)?)/gi;
    let hit;
    while ((hit = outOf.exec(text)) !== null) if (Math.abs(Number(hit[2]) - Number(max)) < 0.01) last = Number(hit[1]);
    if (last != null) return last;
  }
  // "Total = 2 + 2 + 2 = 6": the result after the last "=".
  const sum = text.match(/\btotal[^.\n]*?[:=]\s*((?:\d+(?:\.\d+)?\s*\+\s*)+\d+(?:\.\d+)?)(?:\s*=\s*(\d+(?:\.\d+)?))?/i);
  if (sum) return sum[2] != null ? Number(sum[2]) : sum[1].split('+').reduce((acc, part) => acc + Number(part), 0);
  const patterns = [
    // "Total marks awarded: 4 out of 10", "Total: 4/10"
    /\btotal(?:\s+marks?)?(?:\s+(?:awarded|obtained|scored))?\s*[:=–-]\s*(\d+(?:\.\d+)?)/i,
    /total\s+(\d+(?:\.\d+)?)\s*marks?\b/i,
    /\bearns?\s+(\d+(?:\.\d+)?)\s*marks?\b/i,
    /\bawarded\s+(\d+(?:\.\d+)?)\s*marks?\b/i,
    /(\d+(?:\.\d+)?)\s*marks?\s+awarded\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Instant rule audit. Returns { action: 'ok'|'repair_down', reasons: string[] }.
 * The supervisor never asks for more marks in any mode: the old upward repair
 * and the 0.5 idea-credit clamp are gone.
 */
export function auditGrade(grade, { question, evidence, responseType } = {}) {
  const max = Number(question?.marks_total || grade?.allocated || 0);
  const type = responseType || question?.expected_response_type || '';
  const attempted = evidence?.attempted !== false && grade?.attempted !== false;
  if (!subjectiveType(type) || !attempted) return { action: 'ok', reasons: [] };
  // An answer already credited under another question stays at zero in every mode.
  if (grade?.reviewReasons?.includes(DUPLICATE_EVIDENCE_TAG)) return { action: 'ok', reasons: [] };
  return auditGradeStrict(grade, { max });
}

/**
 * Strict calibration audit: never asks for more marks. Flags grades whose own
 * feedback names an error (or claims fewer marks in prose) while keeping high
 * marks, so a repair pass can only lower them.
 */
export function auditGradeStrict(grade, { max }) {
  const reasons = [];
  const marks = Number(grade?.marks || 0);
  if (!(max > 0) || marks <= 0) return { action: 'ok', reasons };
  if (marks >= 0.5 * max && namesError(grade?.needsAttention)) reasons.push('stated_error_high_marks');
  for (const criterion of (grade?.criteria || [])) {
    if (Number(criterion.max) > 0 && Number(criterion.marks) >= Number(criterion.max) && namesError(criterion.note)) {
      reasons.push(`criterion_full_with_error:${criterion.id}`);
    }
  }
  const claimed = extractClaimedMarks(grade?.reasoning, max);
  if (claimed != null && claimed + 0.01 < marks) reasons.push(`prose_mark_mismatch_down:${claimed}<${marks}`);
  return { action: reasons.length ? 'repair_down' : 'ok', reasons };
}

/**
 * A grade whose reasoning states a different total from its mark, higher or
 * lower: no reader can tell which is right without re-marking. Empty when the
 * grade is consistent.
 */
export function auditConsistency(grade, { max }) {
  const reasons = [];
  const marks = Number(grade?.marks || 0);
  const claimed = extractClaimedMarks(grade?.reasoning, max);
  if (claimed != null && claimed <= max && claimed > marks + 0.01) reasons.push(`prose_mark_mismatch_up:${claimed}>${marks}`);
  // The grader totalled less than the criteria add up to: the criteria credit
  // something its own marking did not (a PartnerD History Q3 said 6/10, stored 10).
  if (claimed != null && claimed + 0.01 < marks) reasons.push(`prose_mark_mismatch_down:${claimed}<${marks}`);
  return reasons;
}

export function withConsistentParts(grade) {
  const parts = Array.isArray(grade?.parts) ? grade.parts : [];
  if (!parts.length) return grade;
  const sum = roundMarks(parts.reduce((acc, part) => acc + (Number(part.marks_obtained) || 0), 0));
  return Math.abs(sum - Number(grade.marks || 0)) > 0.01 ? { ...grade, parts: null } : grade;
}

export function buildReconcilePrompt({ question, evidence, rubric, grade, reasons, subject = '' }) {
  return [
    'You are the grading supervisor. The prior grade disagrees with itself, so a reader cannot tell which mark is right:',
    ...reasons.map((reason) => `- ${reason}`),
    'Re-mark the student answer against the rubric once and return one consistent grade. Judge from the student answer and the rubric, not from either of the prior numbers.',
    'Use each rubric band once (no duplicate criteria); the criteria max values must add up to the question\'s marks. marks_awarded MUST equal the sum of criteria[].marks and, when you return parts, the sum of parts[].marks_obtained. grading_reasoning must state that same total.',
    'Do not remove marks for capitalisation, punctuation, spelling slips or phrasing unless the rubric names them.' + subjectGradingRules(subject || question.test_subject, question.test_title),
    'Return JSON only: {"marks_awarded":0,"criteria":[{"id":"","max":0,"marks":0,"note":""}],"parts":[{"label":"","prompt":"","response":"","expected":"","marks_obtained":0,"marks_total":0,"status":"correct|partial|incorrect|not_attempted"}],"confidence":"low|medium|high","needs_review":false,"review_reasons":[],"what_went_correct":"","needs_attention":"","next_step":"","grading_reasoning":""}.',
    '',
    `Question (${Number(question.marks_total || 0)} marks): ${question.question_text || ''}`,
    `Official answer: ${question.answer_key_text || question.correct_answer || ''}`,
    `Rubric: ${rubric?.marking_rubric || ''}`,
    `Student answer: ${evidence?.student_answer || 'No answer captured.'}`,
    `Previous grade JSON: ${JSON.stringify({
      marks_awarded: grade.marks,
      criteria: grade.criteria || [],
      parts: grade.parts || [],
      grading_reasoning: grade.reasoning,
    })}`,
  ].join('\n');
}

/**
 * Full supervised grade: model grade → normalize → (downward recheck, only for a
 * subject whose profile opts in) → consistency recheck.
 *
 * The downward recheck asks again when a grade's own feedback names an error
 * while keeping high marks, and may lower or keep the mark. It is off for every
 * subject (Oct 2026): it cut marks an independent re-mark upheld (Literature,
 * and Geography answers 4-5 marks under it), and the first grade with each
 * subject's own rules is the mark that stands. A profile turns it back on with
 * `downwardRecheck: true`. Where it runs, only a recheck that fails to settle the
 * mark is flagged.
 *
 * @param {object} args
 * @param {(prompt: string, maxTokens?: number) => Promise<{value: object, model?: string}>} args.callJson
 */
export async function gradeWithSupervision({
  question,
  rubric = {},
  evidence = {},
  subject = '',
  callJson,
  maxTokens = 8000,
}) {
  if (typeof callJson !== 'function') throw new Error('gradeWithSupervision requires callJson');

  const markingRubric = rubric.marking_rubric || question.marking_rubric || '';
  const maxMarks = Number(question.marks_total || 0);
  // A multi-item MCQ block ("1 mark for each correct option") is graded per item.
  const responseType = gradingResponseType(rubric.expected_response_type || question.expected_response_type || '', { marks: maxMarks, markingRubric });
  const rubricCriteria = parseRubricCriteria(markingRubric, maxMarks);
  const language = subject && /hindi/i.test(subject) ? undefined : 'english';
  const mode = gradingCalibrationModeFor(subject || question.test_subject);

  // A block of MCQs with a per-item key is marked letter by letter, not by the model.
  const declaredType = String(rubric.expected_response_type || question.expected_response_type || '').toLowerCase();
  if (declaredType === 'mcq' && responseType !== 'mcq' && evidence.attempted !== false) {
    const block = markMcqBlock({
      keyText: question.answer_key_text || rubric.correct_answer_summary || '',
      questionText: question.question_text || '',
      studentAnswer: evidence.student_answer || '',
      maxMarks,
      markingRubric,
    });
    if (block) {
      const grade = normalizeGradeResult(mcqBlockGradeJson(block, { criterionId: rubricCriteria[0]?.id }), question, evidence, responseType, {
        mode,
        markingRubric,
        rubricCriteria,
        subject,
        language,
      });
      return {
        grade,
        model: 'mcq_letter_match',
        repairModel: null,
        supervisor: {
          action: 'letter_match',
          mode,
          repaired: false,
          enforced: false,
          auditReasons: [],
          finalReasons: [],
          unclearItems: block.unclear,
          at: new Date().toISOString(),
        },
      };
    }
  }

  const prompt = buildGradePrompt({
    question,
    // source_response_type keeps "mcq" for an MCQ block graded item by item.
    rubric: { ...rubric, marking_rubric: markingRubric, expected_response_type: responseType, source_response_type: rubric.expected_response_type || question.expected_response_type || '' },
    evidence,
    maxMarks,
    subject,
  });
  const first = await callJson(prompt, maxTokens);
  const grade = normalizeGradeResult(first.value, question, evidence, responseType, {
    mode,
    markingRubric,
    rubricCriteria,
    subject,
    language,
  });

  const audit = downwardRecheckEnabled(subject || question.test_subject, question.test_title)
    ? auditGrade(grade, { question, evidence, responseType })
    : { action: 'ok', reasons: [] };
  let final = grade;
  let repaired = false;
  let unresolved = false;
  let repairModel = null;
  if (audit.action === 'repair_down') {
    try {
      const second = await callJson(buildDownwardRepairPrompt({
        question,
        evidence,
        rubric: { marking_rubric: markingRubric },
        grade,
        auditReasons: audit.reasons,
        subject,
      }), Math.min(maxTokens, 4000));
      const candidate = normalizeGradeResult(second.value, question, evidence, responseType, {
        markingRubric,
        rubricCriteria,
        subject,
        mode,
        language,
      });
      // The downward repair may only lower marks; a higher answer is ignored.
      // It returns no parts; keep the first pass's sub-part breakdown only when the
      // mark is unchanged, so displayed part marks never disagree with the total.
      if (!candidate.parts?.length && grade.parts?.length && Number(candidate.marks) === Number(grade.marks)) candidate.parts = grade.parts;
      if (Number(candidate.marks) <= Number(grade.marks)) {
        final = candidate;
        repaired = true;
        repairModel = second.model || null;
      } else {
        unresolved = true;
      }
    } catch (repairError) {
      unresolved = true;
      console.warn(JSON.stringify({
        event: 'grade_repair_failed',
        question: question.number || question.question_number || question.id || null,
        subject: subject || '',
        auditReasons: audit.reasons,
        error: String(repairError && repairError.message ? repairError.message : repairError),
      }));
    }
    if (unresolved) {
      final = {
        ...final,
        needsReview: true,
        reviewReasons: mergeReviewTags(final.reviewReasons, STATED_ERROR_TAG),
      };
    }
  }

  final = withConsistentParts(final);
  // A grade whose reasoning states a higher total gets one re-mark, which may go
  // up or down; only one that still disagrees afterwards is flagged.
  const inconsistent = subjectiveType(responseType) && evidence.attempted !== false
    ? auditConsistency(final, { max: maxMarks })
    : [];
  let reconciled = false;
  let finalReasons = [];
  if (inconsistent.length) {
    let candidate = null;
    try {
      const third = await callJson(buildReconcilePrompt({
        question,
        evidence,
        rubric: { marking_rubric: markingRubric },
        grade: final,
        reasons: inconsistent,
        subject,
      }), Math.min(maxTokens, 4000));
      candidate = normalizeGradeResult(third.value, question, evidence, responseType, {
        markingRubric,
        rubricCriteria,
        subject,
        mode,
        language,
      });
      if (!auditConsistency(candidate, { max: maxMarks }).length) {
        final = { ...withConsistentParts(candidate), reviewReasons: mergeReviewTags(candidate.reviewReasons, final.reviewReasons.filter((tag) => tag === STATED_ERROR_TAG)) };
        reconciled = true;
        repairModel = third.model || repairModel;
      }
    } catch (reconcileError) {
      console.warn(JSON.stringify({
        event: 'grade_reconcile_failed',
        question: question.number || question.question_number || question.id || null,
        subject: subject || '',
        reasons: inconsistent,
        error: String(reconcileError && reconcileError.message ? reconcileError.message : reconcileError),
      }));
    }
    if (!reconciled) {
      finalReasons = inconsistent;
      final = {
        ...final,
        needsReview: true,
        reviewReasons: mergeReviewTags(final.reviewReasons, MARKS_INCONSISTENT_TAG),
      };
    }
  }
  return {
    grade: final,
    model: first.model || null,
    repairModel,
    supervisor: {
      action: reconciled ? 'reconciled' : repaired ? 'repaired_down' : unresolved ? 'flagged_down' : inconsistent.length ? 'flagged_inconsistent' : 'ok',
      mode,
      repaired: repaired || reconciled,
      enforced: false,
      auditReasons: [...audit.reasons, ...inconsistent],
      finalReasons,
      at: new Date().toISOString(),
    },
  };
}

export { normalizeCriteria, parseRubricCriteria };
