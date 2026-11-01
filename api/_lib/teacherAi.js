/**
 * Teacher AI helpers — copilot, lesson plan, quiz gen, briefing, interventions,
 * parent communication drafts.
 * Evidence-bound: never invent student scores; ground in cohort/student context.
 */

import { randomUUID } from 'node:crypto';
import {
  assessEvidenceReadiness,
  buildCohortContext,
  buildStudentContext,
  COHORT_MIN_SIGNALS,
  cohortSignalCount,
  InsufficientEvidenceError,
} from './contextBuilder.js';
import { callJsonModel } from './llmGateway.js';
import { listQuestionBank, upsertQuestionBankItem } from './questionBank.js';
import {
  normalizeRecommendations,
  normalizeStrategies,
} from '../../shared/reportActionItems.js';

function text(value) {
  return String(value || '').trim();
}

function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function compactCohort(context) {
  return {
    school: context.schoolName,
    className: context.className,
    subject: context.subject,
    overview: context.overview,
    hotspots: (context.hotspots || []).slice(0, 8),
    curriculumTopics: (context.curriculumTopics || []).slice(0, 20).map((row) => row.topic),
  };
}

/** Evidence gate for teacher generation: no data → no generation. */
function gateCohort(context) {
  const signals = cohortSignalCount(context);
  if (signals < COHORT_MIN_SIGNALS) {
    throw new InsufficientEvidenceError({
      level: 'thin',
      signals,
      needed: COHORT_MIN_SIGNALS,
      reason: `Only ${signals} cohort evidence signal${signals === 1 ? '' : 's'} available; at least ${COHORT_MIN_SIGNALS} are needed. Signals arrive after graded exams are processed.`,
    });
  }
}

export function buildCopilotSystemPrompt() {
  return [
    'You are Skyll Teacher Copilot for Indian school/coaching teachers.',
    'Rules:',
    '- Ground claims in the provided cohort evidence (topics, signal counts, modes).',
    '- Never invent student names, marks, or exams that are not in context.',
    '- If evidence is thin, say what is missing and suggest the next data check.',
    '- No personality/motivation diagnosis — only learning evidence.',
    '- Be concise and actionable for a busy teacher.',
    'Return JSON only: {"reply":"...","actions":["..."],"citations":["topic:..."]}',
  ].join('\n');
}

export function buildLessonPlanSystemPrompt() {
  return [
    'You design a single-period lesson plan for an Indian CBSE/ICSE classroom.',
    'Ground the plan in cohort hotspot topics when provided.',
    'Return JSON only:',
    '{"title":"","objective":"","duration_minutes":40,"warmup":"","teach":["..."],"guided_practice":["..."],"exit_ticket":"","materials":["..."],"differentiation":""}',
  ].join('\n');
}

export function buildQuizGenSystemPrompt() {
  return [
    'You generate short formative quiz questions for an Indian school class.',
    'Prefer curriculum topic names from context. Include answer keys.',
    'Return JSON only:',
    '{"questions":[{"topic":"","difficulty":"easy|medium|hard","question_text":"","answer_key":"","max_marks":2,"rubric":{"marking":""}}]}',
  ].join('\n');
}

export function buildBriefingSystemPrompt() {
  return [
    'You write a morning teacher briefing from cohort evidence.',
    '3–5 bullets max. Prioritize weak topics and suggested classroom moves.',
    'Return JSON only: {"headline":"","bullets":["..."],"focus_topics":["..."],"watch_students_hint":""}',
  ].join('\n');
}

export function buildInterventionSystemPrompt() {
  return [
    'You propose class-segment interventions grounded in hotspot evidence.',
    'Return JSON only:',
    '{"interventions":[{"title":"","segment":"struggling|middle|advanced","action":"","topics":["..."],"minutes":15}]}',
  ].join('\n');
}

export function buildParentReportSystemPrompt() {
  return [
    'You draft a short parent update for an Indian school/coaching teacher to review before sending.',
    'Tone: warm, clear, non-judgmental; no personality/motivation claims.',
    'Ground every claim in the provided evidence (scores, topics, strategies). Never invent marks or exams.',
    'Prefer WhatsApp-length: 120–220 words. Use the student first name only.',
    'Return JSON only:',
    '{"subject_line":"","message":"","talking_points":["..."],"suggested_next_steps":["..."],"tone":"supportive|neutral|urgent"}',
  ].join('\n');
}

export async function loadTeacherCohort(db, scope) {
  return buildCohortContext(db, scope);
}

export async function runTeacherCopilot(db, {
  schoolId,
  question,
  className = null,
  subject = null,
  examId = null,
  history = [],
  callModel = null,
} = {}) {
  const context = await buildCohortContext(db, { schoolId, className, subject, examId });
  gateCohort(context);
  const prompt = [
    'Teacher question:',
    text(question),
    '',
    'Cohort evidence (JSON):',
    JSON.stringify({
      ...compactCohort(context),
      history: (history || []).slice(-6).map((turn) => ({
        role: turn.role,
        content: text(turn.content).slice(0, 500),
      })),
    }),
  ].join('\n');

  let model = null;
  let result;
  try {
    const generated = callModel
      ? await callModel({ prompt, context })
      : await callJsonModel({
        prompt,
        maxTokens: 900,
        model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        system: buildCopilotSystemPrompt(),
      });
    model = generated.model || null;
    result = generated.result || generated;
  } catch {
    throw new Error('Copilot reply failed — model unavailable');
  }

  return {
    reply: text(result.reply) || 'No reply generated.',
    actions: Array.isArray(result.actions) ? result.actions.map(text).filter(Boolean).slice(0, 6) : [],
    citations: Array.isArray(result.citations) ? result.citations.map(text).filter(Boolean).slice(0, 8) : [],
    model,
    context: {
      schoolId: context.schoolId,
      className: context.className,
      subject: context.subject,
      hotspotCount: (context.hotspots || []).length,
    },
  };
}

export async function generateLessonPlan(db, {
  schoolId,
  subject = 'Mathematics',
  topic = null,
  className = null,
  examId = null,
  callModel = null,
} = {}) {
  const context = await buildCohortContext(db, { schoolId, className, subject, examId });
  gateCohort(context);
  const focusTopic = text(topic) || context.hotspots?.[0]?.topic || null;
  const prompt = [
    `Subject: ${subject}`,
    `Focus topic: ${focusTopic || 'choose from hotspots'}`,
    'Cohort evidence:',
    JSON.stringify(compactCohort(context)),
  ].join('\n');

  let model = null;
  let plan;
  try {
    const generated = callModel
      ? await callModel({ prompt, context })
      : await callJsonModel({
        prompt,
        maxTokens: 1100,
        model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        system: buildLessonPlanSystemPrompt(),
      });
    model = generated.model || null;
    plan = generated.result || generated;
  } catch {
    throw new Error('Lesson plan generation failed — model unavailable');
  }

  return {
    title: text(plan.title),
    objective: text(plan.objective),
    duration_minutes: Number(plan.duration_minutes) || 40,
    warmup: text(plan.warmup),
    teach: Array.isArray(plan.teach) ? plan.teach.map(text).filter(Boolean) : [],
    guided_practice: Array.isArray(plan.guided_practice) ? plan.guided_practice.map(text).filter(Boolean) : [],
    exit_ticket: text(plan.exit_ticket),
    materials: Array.isArray(plan.materials) ? plan.materials.map(text).filter(Boolean) : [],
    differentiation: text(plan.differentiation),
    topic: focusTopic,
    subject,
    model,
    source: 'llm',
  };
}

export async function generateQuiz(db, {
  schoolId,
  subject = 'Mathematics',
  topics = null,
  className = null,
  count = 5,
  persistBank = true,
  callModel = null,
} = {}) {
  const context = await buildCohortContext(db, { schoolId, className, subject });
  const focusTopics = Array.isArray(topics) && topics.length
    ? topics.map(text).filter(Boolean)
    : (context.hotspots || []).slice(0, 3).map((row) => row.topic);
  const n = Math.max(3, Math.min(10, Number(count) || 5));

  // Prefer existing bank items when available.
  let bankQuestions = [];
  try {
    for (const topic of focusTopics.slice(0, 3)) {
      const rows = await listQuestionBank(db, {
        board: 'CBSE',
        subject,
        topic,
        limit: 4,
      });
      bankQuestions.push(...rows);
    }
  } catch {
    bankQuestions = [];
  }

  // Evidence gate with explicit-topic exception (curated bank reuse is not personalization).
  const explicitTopics = Array.isArray(topics) && topics.length > 0;
  if (!(explicitTopics && bankQuestions.length > 0)) gateCohort(context);

  let model = null;
  let generatedQuestions = [];
  if (bankQuestions.length >= n) {
    generatedQuestions = bankQuestions.slice(0, n).map((row, index) => ({
      id: `qq_${index + 1}`,
      topic: row.topic,
      difficulty: row.difficulty || 'medium',
      question_text: row.questionText,
      answer_key: row.answerKey,
      max_marks: row.maxMarks || 2,
      rubric: row.rubric || { marking: 'Award method marks.' },
      bankId: row.id,
      source: 'question_bank',
    }));
  } else {
    const prompt = [
      `Subject: ${subject}`,
      `Count: ${n}`,
      `Topics: ${JSON.stringify(focusTopics)}`,
      'Cohort evidence:',
      JSON.stringify(compactCohort(context)),
    ].join('\n');
    try {
      const generated = callModel
        ? await callModel({ prompt, context })
        : await callJsonModel({
          prompt,
          maxTokens: 1400,
          model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
          system: buildQuizGenSystemPrompt(),
        });
      model = generated.model || null;
      const raw = generated.result || generated;
      generatedQuestions = (Array.isArray(raw.questions) ? raw.questions : []).slice(0, n).map((item, index) => ({
        id: `qq_${index + 1}`,
        topic: text(item.topic) || focusTopics[index % Math.max(focusTopics.length, 1)] || subject,
        difficulty: text(item.difficulty) || 'medium',
        question_text: text(item.question_text || item.questionText),
        answer_key: text(item.answer_key || item.answerKey),
        max_marks: Number(item.max_marks ?? item.maxMarks ?? 2) || 2,
        rubric: item.rubric || { marking: text(item.marking) || 'Partial credit for method.' },
        bankId: null,
        source: 'llm',
      })).filter((item) => item.question_text);
    } catch {
      throw new Error('Quiz generation failed — model unavailable');
    }
  }

  if (persistBank && generatedQuestions.length) {
    for (const question of generatedQuestions) {
      if (question.bankId || !question.question_text) continue;
      try {
        const saved = await upsertQuestionBankItem(db, {
          board: 'CBSE',
          grade: className || null,
          subject,
          topic: question.topic,
          difficulty: question.difficulty,
          questionType: 'subjective',
          questionText: question.question_text,
          answerKey: question.answer_key,
          rubric: question.rubric,
          maxMarks: question.max_marks,
          source: 'ai_generated',
          qualityScore: 0.6,
        });
        question.bankId = saved.id;
      } catch {
        /* bank optional in tests */
      }
    }
  }

  return {
    id: id('quiz'),
    subject,
    topics: focusTopics,
    questions: generatedQuestions,
    model,
    source: generatedQuestions[0]?.source || 'llm',
  };
}

export async function generateBriefing(db, {
  schoolId,
  className = null,
  subject = null,
  examId = null,
  callModel = null,
} = {}) {
  const context = await buildCohortContext(db, { schoolId, className, subject, examId });
  gateCohort(context);
  const prompt = [
    'Write the morning briefing from this cohort evidence:',
    JSON.stringify(compactCohort(context)),
  ].join('\n');

  let model = null;
  let briefing;
  try {
    const generated = callModel
      ? await callModel({ prompt, context })
      : await callJsonModel({
        prompt,
        maxTokens: 700,
        model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        system: buildBriefingSystemPrompt(),
      });
    model = generated.model || null;
    briefing = generated.result || generated;
  } catch {
    throw new Error('Briefing generation failed — model unavailable');
  }

  return {
    headline: text(briefing.headline),
    bullets: Array.isArray(briefing.bullets) ? briefing.bullets.map(text).filter(Boolean).slice(0, 6) : [],
    focus_topics: Array.isArray(briefing.focus_topics) ? briefing.focus_topics.map(text).filter(Boolean).slice(0, 5) : [],
    watch_students_hint: text(briefing.watch_students_hint) || null,
    generatedAt: new Date().toISOString(),
    model,
    source: 'llm',
    schoolId: context.schoolId,
    className: context.className,
  };
}

export async function generateInterventions(db, {
  schoolId,
  className = null,
  subject = null,
  examId = null,
  callModel = null,
} = {}) {
  const context = await buildCohortContext(db, { schoolId, className, subject, examId });
  gateCohort(context);
  const prompt = [
    'Propose interventions from cohort evidence:',
    JSON.stringify(compactCohort(context)),
  ].join('\n');

  let model = null;
  let result;
  try {
    const generated = callModel
      ? await callModel({ prompt, context })
      : await callJsonModel({
        prompt,
        maxTokens: 900,
        model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        system: buildInterventionSystemPrompt(),
      });
    model = generated.model || null;
    result = generated.result || generated;
  } catch {
    throw new Error('Intervention generation failed — model unavailable');
  }

  const interventions = Array.isArray(result.interventions) ? result.interventions : [];

  return {
    interventions: interventions.slice(0, 6).map((item) => ({
      title: text(item.title),
      segment: text(item.segment) || 'middle',
      action: text(item.action),
      topics: Array.isArray(item.topics) ? item.topics.map(text).filter(Boolean) : [],
      minutes: Number(item.minutes) || 15,
    })),
    model,
    source: result.source || 'llm',
    schoolId: context.schoolId,
  };
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function firstName(name) {
  const parts = text(name).split(/\s+/).filter(Boolean);
  return parts[0] || 'your child';
}

/** Compact published-report evidence for parent drafts (scores + action items only). */
async function loadParentReportEvidence(db, { schoolId, username, studentId, examId = null }) {
  const args = [schoolId];
  let sql = `SELECT rv.payload_json, rv.published_at, rv.username
             FROM report_versions rv
             JOIN schools sc ON sc.display_name = rv.school
             WHERE sc.id = ? AND rv.status = 'published'`;
  if (username) {
    sql += ' AND rv.username = ?';
    args.push(username);
  } else if (studentId) {
    sql += ' AND rv.student_id = ?';
    args.push(studentId);
  } else {
    return [];
  }
  if (examId) {
    sql += ' AND rv.exam_id = ?';
    args.push(examId);
  }
  sql += ' ORDER BY rv.published_at DESC LIMIT 3';
  const rows = (await db.execute({ sql, args }).catch(() => ({ rows: [] }))).rows || [];
  return rows.map((row) => {
    const payload = parseJson(row.payload_json, {});
    const subject = payload?.term1?.subjects?.[0] || {};
    const strategies = normalizeStrategies(subject.learning_profile?.strategies || subject.strategies, []);
    const recommendations = normalizeRecommendations(subject.recommendations, []);
    const score = subject.score ?? subject.total_score ?? payload?.score ?? null;
    const maxMarks = subject.max_marks ?? subject.maxMarks ?? payload?.max_marks ?? null;
    return {
      publishedAt: row.published_at,
      examName: (payload.exams || [])[0]?.name || subject.name || null,
      subject: subject.name || null,
      score,
      maxMarks,
      coreStrength: text(subject.learning_profile?.core_strength || subject.core_strength),
      patternRecognition: text(subject.learning_profile?.pattern_recognition || subject.pattern_recognition),
      strategies: strategies.slice(0, 4).map((item) => ({
        topic: text(item.topic),
        strategy: text(item.strategy),
      })).filter((item) => item.topic || item.strategy),
      recommendations: recommendations.slice(0, 4).map((item) => ({
        topic: text(item.topic),
        action: text(item.action),
      })).filter((item) => item.topic || item.action),
    };
  });
}

/**
 * Draft a parent-facing update for teacher review (never auto-sends).
 */
export async function generateParentReport(db, {
  schoolId,
  username = null,
  studentId = null,
  subject = null,
  examId = null,
  tone = 'supportive',
  callModel = null,
} = {}) {
  if (!schoolId) throw new Error('schoolId is required');
  if (!username && !studentId) throw new Error('username or studentId is required');

  const context = await buildStudentContext(db, {
    schoolId,
    username: username || undefined,
    studentId: studentId || undefined,
    signalLimit: 40,
    reportLimit: 6,
    includeUnreleased: true,
  });

  const readiness = assessEvidenceReadiness(context);
  const reports = await loadParentReportEvidence(db, {
    schoolId,
    username: context.username || username,
    studentId: context.studentId || studentId,
    examId,
  });
  // Parent drafts may use published reports even when Hive signals are still thin.
  if (readiness.level !== 'ok' && !reports.length) {
    throw new InsufficientEvidenceError({
      ...readiness,
      reason: readiness.reason
        || 'No published report or learning evidence yet for this student.',
    });
  }

  const gaps = (context.signals || [])
    .filter((signal) => text(signal.topic))
    .slice(0, 8)
    .map((signal) => ({
      topic: text(signal.topic),
      misconception: text(signal.misconception).slice(0, 120),
      marks: signal.marksObtained != null && signal.marksTotal != null
        ? `${signal.marksObtained}/${signal.marksTotal}`
        : null,
    }));

  const evidencePack = {
    student: firstName(context.name),
    className: context.className,
    school: context.school,
    subject: subject || reports[0]?.subject || null,
    reports,
    signalGaps: gaps,
    growthEdge: context.dna?.growth_edge || null,
    nextMove: context.dna?.next_move || null,
    preferredTone: text(tone) || 'supportive',
  };

  const prompt = [
    'Draft a parent update from this evidence pack. Teacher will review before sending.',
    JSON.stringify(evidencePack),
  ].join('\n');

  let model = null;
  let draft;
  try {
    const generated = callModel
      ? await callModel({ prompt, context: evidencePack })
      : await callJsonModel({
        prompt,
        maxTokens: 900,
        model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        system: buildParentReportSystemPrompt(),
      });
    model = generated.model || null;
    draft = generated.result || generated;
  } catch {
    throw new Error('Parent report generation failed — model unavailable');
  }

  return {
    id: id('parent'),
    subject_line: text(draft.subject_line) || `Update on ${firstName(context.name)}'s recent assessment`,
    message: text(draft.message),
    talking_points: Array.isArray(draft.talking_points)
      ? draft.talking_points.map(text).filter(Boolean).slice(0, 6)
      : [],
    suggested_next_steps: Array.isArray(draft.suggested_next_steps)
      ? draft.suggested_next_steps.map(text).filter(Boolean).slice(0, 5)
      : [],
    tone: text(draft.tone) || text(tone) || 'supportive',
    review_status: 'draft',
    student: {
      username: context.username,
      studentId: context.studentId,
      name: context.name,
      className: context.className,
    },
    evidence: {
      reports: reports.length,
      signals: (context.signals || []).length,
      readiness: readiness.level,
    },
    generatedAt: new Date().toISOString(),
    model,
    source: 'llm',
    schoolId: context.schoolId,
  };
}
