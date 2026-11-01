/**
 * Evidence-bound revision plan generation.
 */

import { randomUUID } from 'node:crypto';
import { assessEvidenceReadiness, buildStudentContext, InsufficientEvidenceError } from './contextBuilder.js';
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

function topicMasteryFromDna(dna) {
  const rows = Array.isArray(dna?.topic_mastery) ? dna.topic_mastery : [];
  return rows.map((row) => ({
    topic: text(row.topic),
    pct: Number(row.pct) || 0,
    evidence: text(row.evidence),
  })).filter((row) => row.topic);
}

function gapsFromSignals(signals = []) {
  const byTopic = new Map();
  for (const signal of signals) {
    const topic = text(signal.topic) || 'General';
    const entry = byTopic.get(topic) || { topic, misconceptions: [], evidence: [], count: 0 };
    entry.count += 1;
    if (signal.misconception) entry.misconceptions.push(signal.misconception);
    if (signal.questionNumber) entry.evidence.push(`Q${signal.questionNumber}`);
    byTopic.set(topic, entry);
  }
  return [...byTopic.values()].sort((a, b) => b.count - a.count);
}

export function buildRevisionFallback({ subject, mastery, gaps, growthEdge }) {
  const priorities = [];
  for (const gap of gaps.slice(0, 3)) {
    priorities.push({
      topic: gap.topic,
      reason: gap.misconceptions[0] || `Repeated signal across ${gap.count} question(s)`,
      evidence_qids: gap.evidence.slice(0, 5),
      estimated_time: '25 min',
      resources: ['concept recap', '2 practice problems from missed questions'],
    });
  }
  for (const row of mastery.filter((item) => item.pct < 60).slice(0, 3)) {
    if (priorities.some((item) => item.topic === row.topic)) continue;
    priorities.push({
      topic: row.topic,
      reason: `Topic mastery at ${row.pct}%`,
      evidence_qids: [],
      estimated_time: '20 min',
      resources: ['worked example', 'one similar question'],
    });
  }
  if (!priorities.length && growthEdge) {
    priorities.push({
      topic: growthEdge.mode_id || 'Growth edge',
      reason: growthEdge.action || 'Strengthen the current growth edge',
      evidence_qids: [],
      estimated_time: '20 min',
      resources: ['review next_move from Learning DNA'],
    });
  }
  while (priorities.length < 3 && priorities.length > 0) {
    // keep 1–3 items; do not invent filler topics
    break;
  }
  return {
    subject: subject || 'Mathematics',
    priority_1: priorities[0] || null,
    priority_2: priorities[1] || null,
    priority_3: priorities[2] || null,
    total_study_time: `${Math.max(20, priorities.length * 25)} min`,
    strength_to_leverage: mastery.filter((row) => row.pct >= 75).map((row) => row.topic).slice(0, 2).join(', ')
      || 'Use methods that already work on secure topics',
    source: 'heuristic',
  };
}

export function normalizeRevisionPlan(raw, fallback) {
  const plan = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, index) => plan[key] || plan.priorities?.[index] || fallback[key] || null;
  return {
    subject: text(plan.subject) || fallback.subject,
    priority_1: pick('priority_1', 0),
    priority_2: pick('priority_2', 1),
    priority_3: pick('priority_3', 2),
    total_study_time: text(plan.total_study_time) || fallback.total_study_time,
    strength_to_leverage: text(plan.strength_to_leverage) || fallback.strength_to_leverage,
    source: text(plan.source) || 'llm',
  };
}

export async function generateRevisionPlan(db, {
  schoolId,
  username = null,
  studentId = null,
  subject = 'Mathematics',
  callModel = null,
}) {
  if (!schoolId) throw new Error('schoolId is required');
  const context = await buildStudentContext(db, {
    schoolId,
    username: username || undefined,
    studentId: studentId || undefined,
    signalLimit: 40,
    reportLimit: 6,
  });

  // Evidence gate: no data → no generation.
  const readiness = assessEvidenceReadiness(context);
  if (readiness.level !== 'ok') throw new InsufficientEvidenceError(readiness);

  let curriculumTopics = [];
  if (context.studentId) {
    const pack = await getStudentCurriculum(db, {
      schoolId,
      studentId: context.studentId,
      subject,
    }).catch(() => null);
    curriculumTopics = (pack?.standards || []).map((row) => row.topic).slice(0, 30);
  }

  const mastery = topicMasteryFromDna(context.dna);
  const gaps = gapsFromSignals(context.signals);
  const fallback = buildRevisionFallback({
    subject,
    mastery,
    gaps,
    growthEdge: context.dna?.growth_edge,
  });

  const prompt = [
    'Create a prioritized revision plan as JSON with keys:',
    'subject, priority_1, priority_2, priority_3, total_study_time, strength_to_leverage',
    'Each priority object: topic, reason, evidence_qids[], estimated_time, resources[]',
    'Ground every priority in the evidence. Do not invent exams or scores.',
    `Subject focus: ${subject}`,
    `Curriculum topics: ${JSON.stringify(curriculumTopics)}`,
    `Topic mastery: ${JSON.stringify(mastery)}`,
    `Signal gaps: ${JSON.stringify(gaps.slice(0, 10))}`,
    `Growth edge: ${JSON.stringify(context.dna?.growth_edge || null)}`,
    `Next move: ${JSON.stringify(context.dna?.next_move || null)}`,
  ].join('\n');

  try {
    const generated = callModel
      ? await callModel({ prompt, context })
      : await callJsonModel({
        prompt,
        maxTokens: 1100,
        model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        system: 'You create evidence-bound revision plans. Return valid JSON only.',
      });
    const raw = generated.result || generated;
    return normalizeRevisionPlan({ ...raw, source: 'llm' }, fallback);
  } catch {
    throw new Error('Revision plan generation failed — model unavailable');
  }
}

export async function saveRevisionPlan(db, {
  schoolId,
  username = null,
  studentId = null,
  subject = 'Mathematics',
  plan,
  at = new Date().toISOString(),
} = {}) {
  if (!db) throw new Error('database client is required');
  if (!schoolId) throw new Error('schoolId is required');
  const id = `rp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await db.execute({
    sql: `INSERT INTO revision_plans (
            id, school_id, student_id, username, subject, plan_json, source, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, schoolId, studentId, username, subject, JSON.stringify(plan), plan?.source || null, at],
  });
  return id;
}

export async function listRevisionPlans(db, { schoolId, username = null, limit = 10 } = {}) {
  if (!db) throw new Error('database client is required');
  if (!schoolId) throw new Error('schoolId is required');
  const max = Math.max(1, Math.min(30, Number(limit) || 10));
  const result = await db.execute({
    sql: `SELECT id, username, subject, plan_json, created_at
            FROM revision_plans
           WHERE school_id = ?${username ? ' AND username = ?' : ''}
           ORDER BY created_at DESC
           LIMIT ?`,
    args: username ? [schoolId, username, max] : [schoolId, max],
  });
  return (result.rows || []).map((row) => ({
    id: row.id,
    username: row.username,
    subject: row.subject,
    plan: parseJson(row.plan_json, {}),
    createdAt: row.created_at,
  }));
}
