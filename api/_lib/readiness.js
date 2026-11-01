/**
 * Exam readiness score from calibrated KC mastery ∩ target topics.
 * No DNA fallback: zero KC estimates → gated null score.
 */

import { buildStudentContext } from './contextBuilder.js';
import { getStudentCurriculum, listCurriculumStandards } from './curriculumMap.js';

function text(value) {
  return String(value || '').trim();
}

function normalizeTopic(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function clampPct(thetaMean) {
  return Math.min(100, Math.max(0, Math.round((Number(thetaMean) || 0) * 100)));
}

// Duplicate normalized keys keep the MINIMUM pct — pessimistic but deterministic.
function upsertMin(map, key, value) {
  if (!key) return;
  const existing = map.get(key);
  if (!existing || value.pct < existing.pct) map.set(key, value);
}

function kcMasteryMap(mastery) {
  const byLabel = new Map();
  const byStandard = new Map();
  for (const row of mastery || []) {
    const label = text(row.kcLabel || row.topic);
    if (!label) continue;
    const value = { topic: label, pct: clampPct(row.thetaMean) };
    upsertMin(byLabel, normalizeTopic(label), value);
    upsertMin(byStandard, normalizeTopic(row.curriculumStandardId || row.curriculum_standard_id), value);
  }
  return { byLabel, byStandard };
}

function tokensOf(normalized) {
  return normalized.split(/\s+/).filter(Boolean);
}

function containsContiguous(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((token, j) => haystack[i + j] === token)) return true;
  }
  return false;
}

/**
 * Word-boundary matcher (replaces raw bidirectional substring matching).
 * Matches on exact normalized equality, equal token sets, or — multi-token
 * sides only — full contiguous token containment. Single-token keys like
 * "ap" only ever match exact equality, so no substring bleed.
 */
function matchMastery(topic, map) {
  const key = normalizeTopic(topic);
  if (!key) return null;
  if (map.has(key)) return map.get(key);
  const keyTokens = tokensOf(key);
  for (const [candidate, value] of map) {
    const candidateTokens = tokensOf(candidate);
    if (!candidateTokens.length || !keyTokens.length) continue;
    const sameSet = candidateTokens.length === keyTokens.length
      && keyTokens.every((token) => candidateTokens.includes(token));
    if (sameSet) return value;
    if (keyTokens.length >= 2 && candidateTokens.length >= 2
      && (containsContiguous(candidateTokens, keyTokens) || containsContiguous(keyTokens, candidateTokens))) {
      return value;
    }
  }
  return null;
}

/**
 * Pure calculator — exported for tests.
 */
export function computeReadiness({ targetTopics = [], mastery = [] } = {}) {
  const { byLabel, byStandard } = kcMasteryMap(mastery);
  if (!byLabel.size) {
    return {
      score: null,
      explanation: 'Not enough measured evidence yet to estimate readiness.',
      coverage: { targetCount: targetTopics.length, knownCount: 0 },
      breakdown: [],
    };
  }
  const breakdown = [];
  for (const topic of targetTopics) {
    const label = text(topic.topic || topic);
    if (!label) continue;
    // Prefer the curriculum-standard link, then fall back to word-boundary text matching.
    const standardKey = normalizeTopic(topic.standardId || topic.curriculumStandardId || topic.standard_id);
    const hit = (standardKey && byStandard.get(standardKey)) || matchMastery(label, byLabel);
    breakdown.push({
      topic: label,
      masteryPct: hit ? hit.pct : null,
      weight: Number(topic.difficultyWeight ?? topic.difficulty_weight ?? 1) || 1,
      status: !hit ? 'unknown' : hit.pct >= 75 ? 'ready' : hit.pct >= 50 ? 'developing' : 'at_risk',
    });
  }
  const known = breakdown.filter((row) => row.masteryPct != null);
  let score = null;
  if (known.length) {
    const weighted = known.reduce((acc, row) => acc + row.masteryPct * row.weight, 0);
    const denom = known.reduce((acc, row) => acc + row.weight, 0) || 1;
    score = Math.round(weighted / denom);
  }
  const weakest = [...known].sort((a, b) => a.masteryPct - b.masteryPct)[0] || null;
  const explanation = score == null
    ? 'Not enough measured evidence yet to estimate readiness.'
    : weakest
      ? `You're about ${score}% ready. Weakest measured topic: ${weakest.topic} (${weakest.masteryPct}%).`
      : `You're about ${score}% ready based on measured knowledge components.`;
  return {
    score,
    explanation,
    coverage: {
      targetCount: breakdown.length,
      knownCount: known.length,
    },
    breakdown,
  };
}

export async function getReadiness(db, {
  schoolId,
  username = null,
  studentId = null,
  subject = 'Mathematics',
  topics = null,
  board = null,
  grade = null,
} = {}) {
  if (!schoolId) throw new Error('schoolId is required');
  const context = await buildStudentContext(db, {
    schoolId,
    username: username || undefined,
    studentId: studentId || undefined,
  });

  let targetTopics = Array.isArray(topics) ? topics.map((topic) => (
    typeof topic === 'string' ? { topic } : topic
  )) : [];

  if (!targetTopics.length && context.studentId) {
    const pack = await getStudentCurriculum(db, {
      schoolId,
      studentId: context.studentId,
      subject,
    }).catch(() => null);
    targetTopics = (pack?.standards || []).slice(0, 12).map((row) => ({
      topic: row.topic,
      curriculumStandardId: row.id || null,
      difficultyWeight: row.difficultyWeight ?? 1,
    }));
  } else if (!targetTopics.length && (board || grade)) {
    const standards = await listCurriculumStandards(db, {
      board: board || undefined,
      grade: grade || undefined,
      subject,
      limit: 12,
    });
    targetTopics = standards.map((row) => ({
      topic: row.topic,
      curriculumStandardId: row.id || null,
      difficultyWeight: row.difficultyWeight ?? 1,
    }));
  }

  // Prefer low KC mastery focus when curriculum list is huge/generic. Never
  // fabricate pseudo-targets from weakest KC labels — unmatched targets stay
  // unknown and the evidence gate keeps the score honest (null if nothing matches).
  const mastery = [...(context.mastery || [])]
    .map((row) => ({ topic: text(row.kcLabel || row.topic), pct: clampPct(row.thetaMean) }))
    .filter((row) => row.topic)
    .sort((a, b) => a.pct - b.pct);
  if (mastery.length && targetTopics.length > 8) {
    const focus = new Set(mastery.slice(0, 6).map((row) => normalizeTopic(row.topic)));
    targetTopics = targetTopics.filter((row) => focus.has(normalizeTopic(row.topic))).slice(0, 10);
  }

  const readiness = computeReadiness({
    targetTopics,
    mastery: context.mastery,
  });

  return {
    studentId: context.studentId || null,
    username: context.username || username || null,
    subject,
    ...readiness,
  };
}
