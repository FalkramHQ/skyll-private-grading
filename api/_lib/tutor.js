/**
 * Evidence-bound Skyll Tutor — prompt assembly + chat persistence helpers.
 */

import { randomUUID } from 'node:crypto';
import { buildStudentContext } from './contextBuilder.js';
import { getStudentCurriculum } from './curriculumMap.js';
import { callJsonModel } from './llmGateway.js';

function text(value) {
  return String(value || '').trim();
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

export function buildTutorSystemPrompt({ learningMode } = {}) {
  const modeHint = learningMode
    ? `Primary learning mode signal: ${learningMode}. Tailor explanation style to that mode (Architect → why before how; Maker → stepwise practice; Calibrator → check/correct habits; Pathfinder → method selection).`
    : 'Learning mode unknown — keep explanations clear and concrete.';
  return [
    'You are Skyll Tutor, an evidence-bound academic coach for school students in India.',
    'Rules:',
    '- Ground every performance claim in the provided context (question IDs, topics, scores).',
    '- Never invent marks, exams, or weaknesses that are not in the context.',
    '- If evidence is missing, say what is unknown and ask a clarifying question.',
    '- No personality/motivation diagnosis — only learning evidence.',
    '- Prefer board-aligned Maths/Science language; keep responses concise.',
    modeHint,
    'Return JSON only: {"reply":"...","citations":["q..."],"suggested_next":"..."}',
  ].join('\n');
}

export function buildTutorUserPrompt({ question, context, history }) {
  const compact = {
    student: {
      name: context.name,
      grade: context.className,
      board: context.board || null,
      school: context.school,
    },
    learner_dna: context.dna
      ? {
        primary_mode: context.dna.primary_mode || null,
        growth_edge: context.dna.growth_edge || null,
        topic_mastery: context.dna.topic_mastery || [],
        next_move: context.dna.next_move || null,
      }
      : null,
    recent_signals: (context.signals || []).slice(0, 12).map((signal) => ({
      id: signal.id,
      question: signal.questionNumber,
      topic: signal.topic,
      misconception: signal.misconception,
      strength: signal.strength,
      marks: `${signal.marksObtained ?? '?'}/${signal.marksTotal ?? '?'}`,
    })),
    recent_exams: (context.recentReports || []).slice(0, 5),
    curriculum_topics: (context.curriculum || []).slice(0, 20).map((row) => row.topic),
    history: (history || []).slice(-6).map((turn) => ({
      role: turn.message_role || turn.role,
      content: text(turn.content).slice(0, 600),
    })),
  };

  return [
    'Student question:',
    text(question),
    '',
    'Evidence context (JSON):',
    JSON.stringify(compact),
  ].join('\n');
}

/**
 * FLKRM-382: continue a tutor session only if every turn in it belongs to this
 * user in this school. Anything else (unknown, or someone else's id) starts a
 * fresh session, so a leaked id can neither read nor write another chat.
 */
export async function ownedSessionId(db, { sessionId, userId, schoolId }) {
  if (!sessionId || !userId || !schoolId) return null;
  const row = (await db.execute({
    sql: `SELECT COUNT(*) AS turns,
                 SUM(CASE WHEN user_id = ? AND school_id = ? THEN 1 ELSE 0 END) AS owned
          FROM ai_chat_messages WHERE session_id = ?`,
    args: [userId, schoolId, sessionId],
  }).catch(() => ({ rows: [] }))).rows[0];
  const turns = Number(row?.turns || 0);
  return turns > 0 && Number(row.owned) === turns ? sessionId : null;
}

export async function loadChatHistory(db, { sessionId, limit = 12 } = {}) {
  if (!sessionId) return [];
  const result = await db.execute({
    sql: `SELECT id, message_role, content, created_at
          FROM ai_chat_messages
          WHERE session_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [sessionId, limit],
  }).catch(() => ({ rows: [] }));
  return result.rows.reverse();
}

export async function storeChatTurn(db, {
  userId,
  schoolId = null,
  studentId = null,
  role,
  scope = 'tutor',
  sessionId,
  messageRole,
  content,
  contextSnapshot = null,
  modelUsed = null,
  at = new Date().toISOString(),
}) {
  const id = `acm_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await db.execute({
    sql: `INSERT INTO ai_chat_messages (
            id, user_id, school_id, student_id, role, scope, session_id,
            message_role, content, context_snapshot, model_used, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      userId,
      schoolId,
      studentId,
      role,
      scope,
      sessionId,
      messageRole,
      content,
      contextSnapshot ? JSON.stringify(contextSnapshot) : null,
      modelUsed,
      at,
    ],
  });
  return id;
}

/**
 * Run one tutor turn. callModel injectable for tests.
 */
export async function runTutorTurn(db, {
  user,
  schoolId,
  studentId = null,
  username = null,
  question,
  sessionId = null,
  callModel = null,
}) {
  const q = text(question);
  if (!q) throw new Error('question is required');
  if (!schoolId) throw new Error('schoolId is required');

  const sid = await ownedSessionId(db, { sessionId: text(sessionId), userId: user?.user_id, schoolId })
    || `tut_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const context = await buildStudentContext(db, {
    schoolId,
    studentId: studentId || undefined,
    username: username || undefined,
    userId: user?.user_id,
    selfUsername: username && username === user?.username ? username : undefined,
    signalLimit: 20,
    reportLimit: 5,
  });

  let board = null;
  let curriculum = [];
  if (context.studentId) {
    const pack = await getStudentCurriculum(db, {
      schoolId,
      studentId: context.studentId,
      subject: 'Mathematics',
    }).catch(() => null);
    if (pack) {
      board = pack.board;
      curriculum = pack.standards || [];
    }
  }
  context.board = board;
  context.curriculum = curriculum;

  const history = await loadChatHistory(db, { sessionId: sid, limit: 10 });
  const learningMode = context.dna?.primary_mode?.mode_id || context.dna?.primary_mode?.title || null;
  const system = buildTutorSystemPrompt({ learningMode });
  const prompt = buildTutorUserPrompt({ question: q, context, history });

  const generated = callModel
    ? await callModel({ prompt, system, context })
    : await callJsonModel({
      prompt,
      system,
      maxTokens: 900,
      model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    });

  const result = generated.result || generated;
  const reply = text(result.reply) || text(result.message) || 'I need a bit more evidence from your reports to answer that well. Ask about a specific topic or question number.';
  const citations = Array.isArray(result.citations) ? result.citations.map(String) : [];
  const suggestedNext = text(result.suggested_next) || null;
  const model = generated.model || null;

  const snapshot = {
    studentId: context.studentId || null,
    signalCount: context.signals?.length || 0,
    hasDna: Boolean(context.dna),
    board,
    grade: context.className || null,
  };

  await storeChatTurn(db, {
    userId: user.user_id,
    schoolId,
    studentId: context.studentId || null,
    role: user.role,
    scope: 'tutor',
    sessionId: sid,
    messageRole: 'user',
    content: q,
    contextSnapshot: snapshot,
  });
  await storeChatTurn(db, {
    userId: user.user_id,
    schoolId,
    studentId: context.studentId || null,
    role: user.role,
    scope: 'tutor',
    sessionId: sid,
    messageRole: 'assistant',
    content: reply,
    contextSnapshot: { citations, suggestedNext },
    modelUsed: model,
  });

  return {
    sessionId: sid,
    reply,
    citations,
    suggestedNext,
    model,
    context: snapshot,
  };
}

/** Test helper: parse assistant payload shapes. */
export function normalizeTutorResult(raw) {
  const result = parseJson(raw, raw);
  if (!result || typeof result !== 'object') return { reply: text(raw), citations: [], suggestedNext: null };
  return {
    reply: text(result.reply || result.message),
    citations: Array.isArray(result.citations) ? result.citations.map(String) : [],
    suggestedNext: text(result.suggested_next) || null,
  };
}

export async function listTutorSessions(db, { userId, schoolId, limit = 15 } = {}) {
  if (!userId || !schoolId) return [];
  const max = Math.max(1, Math.min(50, Number(limit) || 15));
  const result = await db.execute({
    sql: `SELECT session_id,
                 MIN(created_at) AS started_at,
                 MAX(created_at) AS last_at,
                 COUNT(*) AS turns,
                 MIN(CASE WHEN message_role = 'user' THEN content END) AS first_question
            FROM ai_chat_messages
           WHERE scope = 'tutor' AND user_id = ? AND school_id = ?
           GROUP BY session_id
           ORDER BY MAX(created_at) DESC
           LIMIT ?`,
    args: [userId, schoolId, max],
  }).catch(() => ({ rows: [] }));
  return (result.rows || []).map((row) => ({
    sessionId: row.session_id,
    startedAt: row.started_at,
    lastAt: row.last_at,
    turns: Number(row.turns) || 0,
    firstQuestion: String(row.first_question || '').slice(0, 140),
  }));
}
