// Fair-use rate limit tiers for AI features.
// Tier config is DB-backed with in-memory fallback.

import { database } from './auth.js';

const TIERS = {
  free: { tutorMessagesPerDay: 5, practiceTestsPerWeek: 1, dnaRefreshPerDay: 1, revisionPlansPerDay: 2 },
  student: { tutorMessagesPerDay: 30, practiceTestsPerWeek: 2, dnaRefreshPerDay: 3, revisionPlansPerDay: 5 },
  premium: { tutorMessagesPerDay: 100, practiceTestsPerWeek: 7, dnaRefreshPerDay: 10, revisionPlansPerDay: 20 },
};

export function getTierLimits(tier) {
  return TIERS[tier] || TIERS.student;
}

// student_enrollments.tier defaults to 'standard'; map it onto the fair-use tier.
const TIER_ALIASES = { standard: 'student', default: 'student' };

/**
 * Resolve a student's fair-use tier from their active enrolment.
 * Falls back to 'student' when there is no enrolment row or on error, so AI
 * surfaces never hard-fail because commerce data is missing.
 */
export async function getStudentTier(db, { userId = null, studentId = null, schoolId = null } = {}) {
  try {
    let resolvedStudentId = studentId;
    if (!resolvedStudentId && userId) {
      const row = (await db.execute({
        sql: schoolId
          ? 'SELECT id FROM students WHERE user_id = ? AND school_id = ? LIMIT 1'
          : 'SELECT id FROM students WHERE user_id = ? LIMIT 1',
        args: schoolId ? [userId, schoolId] : [userId],
      })).rows[0];
      resolvedStudentId = row?.id || null;
    }
    if (!resolvedStudentId) return 'student';
    const enrolment = (await db.execute({
      sql: "SELECT tier FROM student_enrollments WHERE student_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
      args: [resolvedStudentId],
    }).catch(() => ({ rows: [] }))).rows[0];
    const raw = enrolment?.tier || 'student';
    return TIER_ALIASES[raw] || (TIERS[raw] ? raw : 'student');
  } catch {
    return 'student';
  }
}

// In-memory fallback for rate limit state
const usageBuckets = new Map();

function bucketKey(username, feature) {
  return `${username}:${feature}`;
}

function getWindowStart(windowDays) {
  const now = new Date();
  if (windowDays === 1) {
    now.setHours(0, 0, 0, 0);
  } else {
    const day = now.getDay();
    now.setDate(now.getDate() - day);
    now.setHours(0, 0, 0, 0);
  }
  return now.toISOString();
}

export async function checkAiRateLimit(username, feature, tier = 'student') {
  const limits = getTierLimits(tier);
  const limitKey = feature === 'tutor' ? 'tutorMessagesPerDay'
    : feature === 'practice' ? 'practiceTestsPerWeek'
    : feature === 'revision' ? 'revisionPlansPerDay'
    : 'dnaRefreshPerDay';
  const max = limits[limitKey] || 10;
  const windowDays = (feature === 'practice') ? 7 : 1;
  const windowStart = getWindowStart(windowDays);
  const key = bucketKey(username, feature);

  // Try DB-backed rate limit
  try {
    const db = database();
    await db.execute(`CREATE TABLE IF NOT EXISTS ai_rate_limits (
      key TEXT NOT NULL, window_start TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key, window_start)
    )`);
    // One atomic step, so concurrent requests cannot all read the same count
    // and slip past the limit. A refused request does not use up quota.
    const result = await db.execute({
      sql: `INSERT INTO ai_rate_limits (key, window_start, count) VALUES (?, ?, 1)
            ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 WHERE count < ?
            RETURNING count`,
      args: [key, windowStart, max],
    });
    const used = result.rows[0]?.count;
    if (used == null) return { limited: true, used: max, limit: max, feature, tier };
    return { limited: false, used, limit: max, feature, tier };
  } catch {
    // In-memory fallback
    const memKey = `${key}:${windowStart}`;
    const count = usageBuckets.get(memKey) || 0;
    if (count >= max) return { limited: true, used: count, limit: max, feature, tier };
    usageBuckets.set(memKey, count + 1);
    return { limited: false, used: count + 1, limit: max, feature, tier };
  }
}

export async function getAiUsage(username) {
  try {
    const db = database();
    const dayStart = getWindowStart(1);
    const weekStart = getWindowStart(7);
    const result = await db.execute({
      sql: `SELECT key, count FROM ai_rate_limits WHERE key LIKE ? AND window_start IN (?, ?)`,
      args: [`${username}:%`, dayStart, weekStart],
    });
    const usage = { tutor: 0, practice: 0, dna: 0 };
    for (const row of result.rows) {
      if (row.key.includes(':tutor')) usage.tutor = row.count;
      else if (row.key.includes(':practice')) usage.practice = row.count;
      else if (row.key.includes(':dna')) usage.dna = row.count;
    }
    return { ...usage, limits: getTierLimits('student') };
  } catch {
    return { tutor: 0, practice: 0, dna: 0, limits: getTierLimits('student') };
  }
}
