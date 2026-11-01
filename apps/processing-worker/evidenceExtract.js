// Reading one student's answers from their answer-sheet OCR: clean the OCR,
// extract each question's answer (deterministic for all-MCQ papers, chunked model
// calls otherwise, with the supervisor's coverage retry and a presence gap-fill),
// attach source pages and find answers credited under two questions.
//
// Moved out of processEvidence unchanged so the grading evaluation
// (scripts/evalGrading.mjs re-extract) runs exactly the worker's extraction on
// stored OCR. No database access: the model call and the page loader are passed in.
import { answerSheetOcrBundle, dropDuplicatePages } from './ocrText.js';
import { cleanOcrText, buildExtractionPrompt, parseMcqAnswersFromOcr, overlayLetterOnlyAnswersFromNumberedOcr, selectMaxTokens, shouldUseMarkers } from './evidencePipeline.js';
import { normalizeEvidenceAnswers, answerPresenceCount, answerFoundInOcr, questionKey } from './evidenceAnswers.js';
import { withSourcePages } from './sourcePages.js';
import { text } from './workerUtils.js';
import { findDuplicateAnswers } from '../../shared/gradingCalibration.js';

export function rubricLooksAllMcq(questions = []) {
  return questions.length > 0 && questions.every((question) => String(question.expected_response_type || '').toLowerCase() === 'mcq');
}

/**
 * @param {object} args
 * @param {object[]} args.assets answer-sheet OCR rows for one student, in page order
 * @param {{questions: object[]}} args.rubric the active rubric
 * @param {string} args.subject the test's subject
 * @param {import('./evidenceSupervisor.js').EvidenceSupervisor} args.supervisor shared across a test's students
 * @param {(prompt: string, maxTokens: number, effort?: string) => Promise<{value: object}>} args.callJson
 * @param {() => Promise<object[]>} [args.loadSheetPages] per-page OCR text for source pages
 * @returns {Promise<{answers: object[], ocrIncomplete: boolean, duplicateOf: Map, studentHadPresenceGap: boolean, paperIsAllMcq: boolean, duplicatePageAssetIds: string[]}>}
 */
export async function extractStudentAnswers({ assets, rubric, subject, supervisor, callJson, loadSheetPages = async () => [], studentName = '', studentId = '' }) {
  const classification = supervisor.classification;
  const chunks = supervisor.chunks;
  const useMarkers = shouldUseMarkers(rubric.questions, subject);
  // Stage 1: Merge + clean OCR (PRIMARY only — supplementary runs add noise that confuses extraction)
  // A page uploaded twice is read once (extraction only; teachers still see every page).
  const deduped = dropDuplicatePages(assets);
  if (deduped.duplicateAssetIds.length) console.log(JSON.stringify({ event: 'evidence_duplicate_pages_dropped', student: studentName, assetIds: deduped.duplicateAssetIds }));
  const ocrBundle = answerSheetOcrBundle(deduped.rows);
  const rawOcr = ocrBundle.text;
  const ocrText = cleanOcrText(rawOcr, { preserveMarkers: useMarkers });
  // Pages that were clipped or never reached the prompt make every blank answer
  // untrustworthy: block those blanks for review instead of grading them 0.
  const ocrIncomplete = ocrBundle.clippedAssetIds.length > 0 || ocrBundle.droppedAssetIds.length > 0;
  console.log(JSON.stringify({ event: 'evidence_prompt_building', student: studentName, rawChars: rawOcr.length, cleanChars: ocrText.length, assets: assets.length }));
  if (ocrIncomplete) console.log(JSON.stringify({ event: 'evidence_ocr_incomplete', student: studentName, studentId: studentId, clippedAssetIds: ocrBundle.clippedAssetIds, droppedAssetIds: ocrBundle.droppedAssetIds }));

  const paperIsAllMcq = rubricLooksAllMcq(rubric.questions) || classification.allMcq;
  let allModelAnswers = [];

  // All-MCQ: prefer deterministic number→letter parsing. Keyword LLM extraction
  // systematically blanks these sheets ("1] A" has no science keywords).
  if (paperIsAllMcq) {
    const parsed = parseMcqAnswersFromOcr(
      ocrText,
      rubric.questions.map((q) => q.number || q.question_number),
    );
    allModelAnswers = rubric.questions.map((question) => {
      const number = String(question.number || question.question_number || '');
      const digits = number.replace(/^Q/i, '');
      const hit = parsed.get(number) || parsed.get(`Q${digits}`) || parsed.get(digits);
      return {
        question_number: number,
        attempted: Boolean(hit?.letter),
        student_answer: hit?.letter || '',
        crossed_out_work: '',
        source_pages: [],
        confidence: hit ? 'high' : 'medium',
        needs_visual_rescue: false,
        visual_reason: '',
      };
    });
    const parsedCoverage = allModelAnswers.filter((a) => a.attempted).length / Math.max(1, rubric.questions.length);
    console.log(JSON.stringify({
      event: 'evidence_mcq_deterministic',
      student: studentName,
      attempted: allModelAnswers.filter((a) => a.attempted).length,
      total: rubric.questions.length,
      coverage: parsedCoverage,
    }));
    // If OCR is sparse/garbled, fall back to the MCQ-number LLM prompt for gaps only.
    if (parsedCoverage < 0.35) {
      for (const chunk of chunks) {
        const prompt = buildExtractionPrompt(chunk, ocrText, classification, subject);
        const maxTokens = selectMaxTokens(chunk);
        const result = await callJson(prompt, maxTokens);
        const chunkAnswers = Array.isArray(result.value?.answers) ? result.value.answers : [];
        for (const item of chunkAnswers) {
          const number = String(item.question_number || item.number || '');
          const idx = allModelAnswers.findIndex((a) => String(a.question_number) === number);
          if (idx < 0) continue;
          if (allModelAnswers[idx].attempted) continue;
          if (item.attempted && text(item.student_answer || item.student_wrote)) {
            allModelAnswers[idx] = {
              ...allModelAnswers[idx],
              attempted: true,
              student_answer: text(item.student_answer || item.student_wrote, 40),
              confidence: ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : 'medium',
            };
          }
        }
      }
    }
  } else {
    // Stage 2: Extract (chunked for large papers, single-pass otherwise)
    for (const chunk of chunks) {
      const prompt = buildExtractionPrompt(chunk, ocrText, classification, subject);
      const maxTokens = selectMaxTokens(chunk);
      const result = await callJson(prompt, maxTokens);
      const chunkAnswers = Array.isArray(result.value?.answers) ? result.value.answers : [];
      allModelAnswers.push(...chunkAnswers);
    }

    // Stage 3: Supervisor verdict — retry with deeper reasoning if coverage is low
    let coverage = allModelAnswers.filter((a) => a.attempted).length / rubric.questions.length;
    let verdict = supervisor.onStudentComplete({ attempted: allModelAnswers.filter((a) => a.attempted).length, total: rubric.questions.length, answers: allModelAnswers });
    if (verdict.action === 'pause') {
      console.log(JSON.stringify({ event: 'evidence_supervisor_halt', reason: verdict.reason, avgCoverage: verdict.avgCoverage }));
      throw new Error(`Supervisor halted: ${verdict.reason}`);
    }
    if (verdict.action === 'retry') {
      console.log(JSON.stringify({ event: 'evidence_retry', student: studentName, coverage, reasoning: verdict.reasoning }));
      allModelAnswers = [];
      for (const chunk of chunks) {
        const prompt = buildExtractionPrompt(chunk, ocrText, classification, subject);
        const maxTokens = selectMaxTokens(chunk);
        const result = await callJson(prompt, maxTokens, verdict.reasoning || 'medium');
        const chunkAnswers = Array.isArray(result.value?.answers) ? result.value.answers : [];
        allModelAnswers.push(...chunkAnswers);
      }
      coverage = allModelAnswers.filter((a) => a.attempted).length / rubric.questions.length;
      console.log(JSON.stringify({ event: 'evidence_retry_done', student: studentName, attempted: allModelAnswers.filter((a) => a.attempted).length, total: rubric.questions.length, coverage }));
    }
  }
  // Keep cohort stats honest for MCQ deterministic path too
  if (paperIsAllMcq) {
    supervisor.onStudentComplete({
      attempted: allModelAnswers.filter((a) => a.attempted).length,
      total: rubric.questions.length,
      answers: allModelAnswers,
    });
  }
  // FLKRM-152: a truncated/missing model response is retried once more before
  // persisting. If a rubric question still has no answer entry after the retry,
  // normalizeEvidenceAnswers defaults its confidence to 'low' so it is flagged
  // (evidence_blocked) instead of being silently graded 0.
  // Track whether this student had a presence shortfall (truncation / chunk
  // drop) — used later to decide retry eligibility (FLKRM-152 review #2).
  let studentHadPresenceGap = false;
  if (answerPresenceCount({ answers: allModelAnswers }, rubric) < rubric.questions.length) {
    studentHadPresenceGap = true;
    // Key normalization must match normalizeEvidenceAnswers / answerPresenceCount
    // (trim + lowercase) so "Q1" vs "q1" vs "1" do not skip gap-fill or duplicate.
    const presentBefore = new Set(allModelAnswers.map((a) => questionKey(a.question_number || a.number)));
    const reExtracted = [];
    for (const chunk of chunks) {
      const prompt = buildExtractionPrompt(chunk, ocrText, classification, subject);
      const maxTokens = selectMaxTokens(chunk);
      const result = await callJson(prompt, maxTokens, 'high');
      const chunkAnswers = Array.isArray(result.value?.answers) ? result.value.answers : [];
      for (const item of chunkAnswers) {
        const number = questionKey(item.question_number || item.number);
        if (presentBefore.has(number)) continue; // gap-fill only
        reExtracted.push(item);
      }
    }
    if (reExtracted.length) allModelAnswers.push(...reExtracted);
    console.log(JSON.stringify({ event: 'evidence_presence_retry', student: studentName, presentBefore: presentBefore.size, total: rubric.questions.length, recovered: reExtracted.length }));
  }
  console.log(JSON.stringify({ event: 'evidence_student_done', student: studentName, attempted: allModelAnswers.filter((a) => a.attempted).length, total: rubric.questions.length }));

  // Pages come from matching each answer's text against the sheet's OCR
  // (#343); the model never sees page boundaries. A lookup failure only
  // costs the page hints, never the student's evidence.
  const sheetPages = await loadSheetPages().catch((error) => {
    console.log(JSON.stringify({ event: 'evidence_source_pages_failed', student: studentName, error: error.message }));
    return [];
  });
  const located = withSourcePages(
    overlayLetterOnlyAnswersFromNumberedOcr(
      normalizeEvidenceAnswers({ answers: allModelAnswers }, rubric),
      ocrText,
    ),
    sheetPages,
  );
  // An answer whose words are not in the OCR was rewritten by the model, not
  // read: keep it, but at low confidence so the teacher checks it.
  const answers = located.map((answer) => (
    answer.attempted && answer.confidence !== 'low' && !answerFoundInOcr(answer.studentAnswer, ocrText)
      ? { ...answer, confidence: 'low', notVerbatim: true }
      : answer
  ));
  const rewritten = answers.filter((answer) => answer.notVerbatim).map((answer) => answer.question.number);
  if (rewritten.length) console.log(JSON.stringify({ event: 'evidence_not_verbatim', student: studentName, questions: rewritten }));
  // One written answer extracted under two questions is credited once: the
  // better-matching question keeps it, the other records duplicate_of.
  const duplicateOf = findDuplicateAnswers(answers.map((item) => ({
    questionNumber: item.question.number,
    questionText: item.question.question_text,
    answerKey: item.question.correct_answer_summary,
    studentAnswer: item.studentAnswer,
  })));
  return { answers, ocrIncomplete, duplicateOf, studentHadPresenceGap, paperIsAllMcq, duplicatePageAssetIds: deduped.duplicateAssetIds };
}
