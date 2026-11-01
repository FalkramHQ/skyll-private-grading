/**
 * Persistence for teacher-generated AI artifacts
 * (lesson plans, quizzes, interventions) so they can be listed and re-opened.
 */

import { randomUUID } from 'node:crypto';

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function saveAiArtifact(db, {
  schoolId,
  userId = null,
  type,
  scope = {},
  payload,
  at = new Date().toISOString(),
} = {}) {
  if (!db) throw new Error('database client is required');
  if (!schoolId) throw new Error('schoolId is required');
  if (!type) throw new Error('type is required');
  const id = `aa_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await db.execute({
    sql: `INSERT INTO ai_artifacts (
            id, school_id, user_id, artifact_type, scope_json, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, schoolId, userId, type, JSON.stringify(scope), JSON.stringify(payload), at],
  });
  return id;
}

export async function listAiArtifacts(db, { schoolId, userId = null, type = null, limit = 15 } = {}) {
  if (!db) throw new Error('database client is required');
  if (!schoolId) throw new Error('schoolId is required');
  const max = Math.max(1, Math.min(50, Number(limit) || 15));
  const where = ['school_id = ?'];
  const args = [schoolId];
  if (userId) {
    where.push('user_id = ?');
    args.push(userId);
  }
  if (type) {
    where.push('artifact_type = ?');
    args.push(type);
  }
  args.push(max);
  const result = await db.execute({
    sql: `SELECT id, artifact_type, scope_json, payload_json, created_at
            FROM ai_artifacts
           WHERE ${where.join(' AND ')}
           ORDER BY created_at DESC
           LIMIT ?`,
    args,
  });
  return (result.rows || []).map((row) => ({
    id: row.id,
    type: row.artifact_type,
    scope: parseJson(row.scope_json, {}),
    payload: parseJson(row.payload_json, null),
    createdAt: row.created_at,
  }));
}
