/**
 * Deep signal extraction for Learning Hive (plan2 Phase 1).
 * Batches graded long-form questions and writes evidence_signals rows.
 */

import { randomUUID } from 'node:crypto';
import { callJsonModel } from '../../api/_lib/llmGateway.js';
import { normalizeMisconceptionClass } from '../../api/_lib/misconceptionTaxonomy.js';
import { resolveExamMeta } from '../../api/_lib/examMeta.js';
import { buildKcAllowlist } from '../../api/_lib/kcAllowlist.js';

export const DEEP_SIGNAL_EXTRACTOR_VERSION = 'deep-signal-v1';
export const DEEP_SIGNAL_EXTRACTOR_VERSION_V2 = 'deep-signal-v2';
export const DEEP_SIGNAL_BATCH_SIZE = 4;

const SKIP_RESPONSE_TYPES = new Set(['mcq', 'multiple_choice', 'true_false', 'fill_blank']);

function text(value) {
  return String(value || '').trim();
}

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export function shouldExtractQuestion(question = {}) {
  const responseType = text(question.expectedResponseType || question.expected_response_type || question.responseType).toLowerCase();
  if (SKIP_RESPONSE_TYPES.has(responseType)) return false;
  const marksTotal = Number(question.marksTotal ?? question.marks_total ?? question.marksAllocated ?? 0);
  if (!(marksTotal > 1)) return false;
  const attempted = question.attempted !== false;
  if (!attempted) return false;
  return true;
}

export function buildSignalExtractionPrompt(batch, meta = {}) {
  return [
    'Extract evidence-bound learning signals from graded exam questions.',
    'Use only the supplied question, rubric, student answer, and grading rationale.',
    'Do not invent evidence, personality traits, motivation, or scores.',
    'Skip any item that lacks enough grounded detail; return an empty object for that question_number.',
    'Return JSON only:',
    '{"signals":[{"question_number":"","concept_tags":[""],"misconception":"","strength":"","method_note":"","next_practice":"","confidence":0.0,"evidence_refs":[""]}]}',
    'confidence is 0..1. evidence_refs must cite question_number and/or short grounded snippets from the student answer.',
    '',
    `School: ${meta.school || ''}`,
    `Subject: ${meta.subject || ''}`,
    `Student: ${meta.studentName || ''}`,
    '',
    'Questions:',
    JSON.stringify(batch.map((item) => ({
      question_number: item.questionNumber,
      topic: item.topic,
      marks: `${item.marksObtained}/${item.marksTotal}`,
      question_text: item.questionText,
      rubric: item.markingRubric,
      student_answer: item.studentAnswer,
      what_went_correct: item.whatWentCorrect,
      missing_or_wrong: item.missingOrWrong,
      grading_reason: item.gradingReason,
      next_step: item.nextStep,
    }))),
  ].join('\n');
}

export function normalizeExtractedSignals(result, batch) {
  const byNumber = new Map(batch.map((item) => [text(item.questionNumber).toLowerCase(), item]));
  const rows = Array.isArray(result?.signals) ? result.signals : [];
  const normalized = [];
  for (const row of rows) {
    const key = text(row.question_number || row.questionNumber).toLowerCase();
    const source = byNumber.get(key);
    if (!source) continue;
    const confidence = Number(row.confidence);
    normalized.push({
      submissionQuestionId: source.submissionQuestionId,
      questionNumber: source.questionNumber,
      topic: source.topic || text(row.topic) || null,
      marksObtained: source.marksObtained,
      marksTotal: source.marksTotal,
      conceptTags: Array.isArray(row.concept_tags) ? row.concept_tags.map(text).filter(Boolean).slice(0, 8) : [],
      misconception: text(row.misconception) || null,
      strength: text(row.strength) || null,
      methodNote: text(row.method_note || row.methodNote) || null,
      nextPractice: text(row.next_practice || row.nextPractice) || null,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
      evidenceRefs: Array.isArray(row.evidence_refs)
        ? row.evidence_refs.map(text).filter(Boolean).slice(0, 8)
        : [source.questionNumber].filter(Boolean),
      raw: row,
    });
  }
  return normalized;
}

export function chunkQuestions(questions, size = DEEP_SIGNAL_BATCH_SIZE) {
  const chunks = [];
  for (let index = 0; index < questions.length; index += size) {
    chunks.push(questions.slice(index, index + size));
  }
  return chunks;
}

export function questionFromDbRow(row) {
  const rubric = parseJson(row.rubric_json, {});
  const evidence = parseJson(row.evidence_json, {});
  const payload = parseJson(row.payload_json, {});
  const rationale = payload.gradeRationale || {};
  const payloadAnswer = payload.studentAnswer;
  const studentAnswer = text(
    evidence.student_answer
    || evidence.studentAnswer
    || (typeof payloadAnswer === 'string' ? payloadAnswer : payloadAnswer?.studentWrote)
    || '',
  );
  return {
    submissionQuestionId: row.id,
    questionNumber: row.question_number,
    questionText: row.question_text || '',
    topic: rubric.topic || 'General',
    expectedResponseType: rubric.expected_response_type || rubric.expectedResponseType || payload.expectedResponseType || '',
    markingRubric: typeof rubric.marking_rubric === 'string' ? rubric.marking_rubric : (rubric.markingRubric || row.answer_key_text || ''),
    marksObtained: Number(row.approved_marks ?? row.ai_marks ?? 0),
    marksTotal: Number(row.marks_total || payload?.grade?.allocated || 0),
    attempted: evidence.attempted !== false && text(payload?.grade?.status).toLowerCase() !== 'not_attempted',
    studentAnswer,
    whatWentCorrect: rationale.whatWentCorrect || '',
    missingOrWrong: rationale.missingOrWrong || '',
    gradingReason: rationale.reasoning || '',
    nextStep: rationale.nextStep || '',
  };
}

export async function loadExtractableQuestions(db, submissionId) {
  const result = await db.execute({
    sql: `SELECT id, question_number, question_text, answer_key_text, rubric_json, evidence_json,
                 payload_json, ai_marks, approved_marks, marks_total, status
          FROM submission_questions
          WHERE submission_id = ?
          ORDER BY question_number COLLATE NOCASE`,
    args: [submissionId],
  });
  return result.rows.map(questionFromDbRow).filter(shouldExtractQuestion);
}

export async function extractSignalsForBatch(batch, meta, options = {}) {
  if (!batch.length) return { signals: [], model: null, usage: null };
  const model = options.model
    || process.env.DEEPSEEK_FLASH_MODEL
    || process.env.DEEPSEEK_EXAM_MODEL
    || process.env.DEEPSEEK_MODEL
    || 'deepseek-v4-flash';
  const { result, model: usedModel, usage } = await callJsonModel({
    prompt: buildSignalExtractionPrompt(batch, meta),
    maxTokens: options.maxTokens || 1800,
    model,
    temperature: 0.1,
    system: 'You extract compact, evidence-bound academic learning signals. Return valid JSON only.',
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    attempts: options.attempts || 3,
    retryDelayMs: options.retryDelayMs,
  });
  return {
    signals: normalizeExtractedSignals(result, batch),
    model: usedModel || model,
    usage,
  };
}

export function buildSignalExtractionPromptV2(batch, meta, allowlist) {
  const kcList = Object.entries(allowlist.byId).map(([id, v]) => ({ kc_id: id, label: v.label, cognitive: v.cognitive }));
  return [
    'Extract evidence-bound learning signals from graded exam questions.',
    'Use only the supplied question, rubric, student answer, and grading rationale.',
    'Do not invent evidence, personality traits, motivation, or scores.',
    'Tag each signal with kc_ids FROM THE ALLOWLIST ONLY (drop anything not listed).',
    'Classify misconception using the curated enum: sign-error, distribution-misuse, formula-misapplication, notation-error, procedural-skip, concept-confusion, arithmetic-slip, unit-error, diagram-misread.',
    'Skip items lacking grounded detail; return an empty object for that question_number.',
    'Return JSON only: {"signals":[{"question_number":"","kc_ids":[""],"misconception":"","strength":"","next_practice":"","confidence":0.0,"evidence_refs":[""]}]}',
    '',
    `Subject: ${meta.subject || ''}`, `Student: ${meta.studentName || ''}`,
    'KC allowlist:', JSON.stringify(kcList),
    'Questions:', JSON.stringify(batch.map((item) => ({
      question_number: item.questionNumber, topic: item.topic, marks: `${item.marksObtained}/${item.marksTotal}`,
      question_text: item.questionText, rubric: item.markingRubric, student_answer: item.studentAnswer,
      what_went_correct: item.whatWentCorrect, missing_or_wrong: item.missingOrWrong, grading_reason: item.gradingReason, next_step: item.nextStep,
    }))),
  ].join('\n');
}

function clampConfidence(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

export function normalizeExtractedSignalsV2(result, batch, allowlist, subject) {
  const byNumber = new Map(batch.map((item) => [String(item.questionNumber).toLowerCase(), item]));
  const rows = Array.isArray(result?.signals) ? result.signals : [];
  const out = [];
  for (const row of rows) {
    const key = String(row.question_number || row.questionNumber).toLowerCase();
    const source = byNumber.get(key);
    if (!source) continue;
    const kcIds = (Array.isArray(row.kc_ids) ? row.kc_ids : []).map(String).filter((id) => allowlist.validIds.has(id)).slice(0, 8);
    out.push({
      submissionQuestionId: source.submissionQuestionId,
      questionNumber: source.questionNumber,
      topic: source.topic || null,
      marksObtained: source.marksObtained,
      marksTotal: source.marksTotal,
      conceptTags: kcIds,
      misconceptionClass: normalizeMisconceptionClass(subject, row.misconception),
      misconception: String(row.misconception || '').trim() || null,
      strength: String(row.strength || '').trim() || null,
      methodNote: null,
      nextPractice: String(row.next_practice || '').trim() || null,
      confidence: clampConfidence(row.confidence),
      evidenceRefs: Array.isArray(row.evidence_refs) ? row.evidence_refs.map(String).filter(Boolean).slice(0, 8) : [source.questionNumber],
      raw: row,
    });
  }
  return out;
}

export async function extractSignalsForBatchV2(batch, meta, allowlist, options = {}) {
  if (!batch.length) return { signals: [], model: null, usage: null };
  const model = options.model
    || process.env.DEEPSEEK_FLASH_MODEL
    || process.env.DEEPSEEK_EXAM_MODEL
    || process.env.DEEPSEEK_MODEL
    || 'deepseek-v4-flash';
  const { result, model: usedModel, usage } = await callJsonModel({
    prompt: buildSignalExtractionPromptV2(batch, meta, allowlist),
    maxTokens: options.maxTokens || 1800,
    model,
    temperature: 0.1,
    system: 'You extract compact, evidence-bound academic learning signals. Return valid JSON only.',
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    attempts: options.attempts || 3,
    retryDelayMs: options.retryDelayMs,
  });
  return {
    signals: normalizeExtractedSignalsV2(result, batch, allowlist, meta.subject),
    model: usedModel || model,
    usage,
  };
}

export async function persistSignals(db, {
  schoolId,
  studentId,
  submissionId,
  examId = null,
  signals,
  model,
  extractedAt = new Date().toISOString(),
}) {
  if (!schoolId || !studentId || !submissionId) throw new Error('schoolId, studentId, and submissionId are required');
  const ops = [];
  for (const signal of signals) {
    const signalId = `esig_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    // v2 signals carry KC ids + a curated misconception class; v1 signals lack
    // the misconceptionClass key entirely, so the new columns keep their DB defaults.
    const hasV2Fields = Object.prototype.hasOwnProperty.call(signal, 'misconceptionClass');
    const extraColumns = hasV2Fields ? ', kc_ids_json, misconception_class' : '';
    const extraValues = hasV2Fields ? ', ?, ?' : '';
    const extraUpdate = hasV2Fields
      ? ',\n              kc_ids_json = excluded.kc_ids_json,\n              misconception_class = excluded.misconception_class'
      : '';
    ops.push({
      sql: `INSERT INTO evidence_signals (
              id, school_id, student_id, submission_id, submission_question_id, exam_id,
              question_number, topic, marks_obtained, marks_total, concept_tags_json,
              misconception, strength, method_note, next_practice, confidence,
              evidence_refs_json, raw_json, model, extractor_version, status, extracted_at, created_at${extraColumns}
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?${extraValues})
            ON CONFLICT(submission_question_id) DO UPDATE SET
              topic = excluded.topic,
              marks_obtained = excluded.marks_obtained,
              marks_total = excluded.marks_total,
              concept_tags_json = excluded.concept_tags_json,
              misconception = excluded.misconception,
              strength = excluded.strength,
              method_note = excluded.method_note,
              next_practice = excluded.next_practice,
              confidence = excluded.confidence,
              evidence_refs_json = excluded.evidence_refs_json,
              raw_json = excluded.raw_json,
              model = excluded.model,
              extractor_version = excluded.extractor_version,
              status = 'active',
              extracted_at = excluded.extracted_at${extraUpdate}`,
      args: [
        signalId,
        schoolId,
        studentId,
        submissionId,
        signal.submissionQuestionId,
        examId,
        signal.questionNumber,
        signal.topic,
        signal.marksObtained,
        signal.marksTotal,
        JSON.stringify(signal.conceptTags || []),
        signal.misconception,
        signal.strength,
        signal.methodNote,
        signal.nextPractice,
        signal.confidence,
        JSON.stringify(signal.evidenceRefs || []),
        JSON.stringify(signal.raw || {}),
        model || null,
        hasV2Fields ? DEEP_SIGNAL_EXTRACTOR_VERSION_V2 : DEEP_SIGNAL_EXTRACTOR_VERSION,
        extractedAt,
        extractedAt,
        ...(hasV2Fields ? [JSON.stringify(signal.conceptTags || []), signal.misconceptionClass || null] : []),
      ],
    });
  }
  if (ops.length) await db.batch(ops, 'write');
  return ops.length;
}

export async function runDeepSignalExtraction(db, {
  submissionId,
  schoolId,
  studentId,
  examId = null,
  school = '',
  subject = '',
  studentName = '',
  callModel,
}) {
  const questions = await loadExtractableQuestions(db, submissionId);
  if (!questions.length) {
    return { extracted: 0, skipped: true, reason: 'no_extractable_questions', model: null };
  }
  // Resolve the per-exam KC allowlist. Exams without resolvable exam meta or an
  // empty allowlist silently fall back to the v1 extractor (v2 is additive only).
  // Resolution failures (missing knowledge_components table, transient DB errors)
  // must never kill extraction, so they degrade to the v1 path as well.
  let examMeta = null;
  let kcAllowlist = null;
  if (examId) {
    try {
      examMeta = await resolveExamMeta(db, examId);
      if (examMeta) {
        kcAllowlist = await buildKcAllowlist(db, examMeta);
        if (!kcAllowlist.validIds.size) kcAllowlist = null;
      }
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'deep_signal_allowlist_resolution_failed',
        submissionId,
        examId,
        error: String(error?.message || error),
      }));
      examMeta = null;
      kcAllowlist = null;
    }
  }
  const batches = chunkQuestions(questions);
  const allSignals = [];
  let model = null;
  for (const batch of batches) {
    const extracted = callModel
      ? await callModel(batch)
      : kcAllowlist
        ? await extractSignalsForBatchV2(batch, { school, subject: examMeta.subject || subject, studentName }, kcAllowlist)
        : await extractSignalsForBatch(batch, { school, subject, studentName });
    model = extracted.model || model;
    allSignals.push(...extracted.signals);
  }
  const written = await persistSignals(db, {
    schoolId,
    studentId,
    submissionId,
    examId,
    signals: allSignals,
    model,
  });
  return { extracted: written, skipped: false, questionCount: questions.length, batchCount: batches.length, model };
}
