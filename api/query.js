import { createClient } from '@libsql/client/web';
import { ensureAuthTables, requireUser } from './_lib/auth.js';
import { tursoAuthToken, tursoUrl } from './_lib/env.js';
import { handleCors } from './_lib/cors.js';
import { checkRateLimit } from './_lib/rateLimit.js';
import { resolveSchoolId } from './_lib/canonicalSubmissions.js';
import { internalError } from './_lib/httpError.js';
import { callJsonModel } from './_lib/llmGateway.js';
import { enablePrivateInferenceFor, inferenceContextForUser } from './_lib/privateInferenceRequest.js';
import { nearPrivateEnabledForCurrentJob, runWithInferenceContext } from '../apps/processing-worker/inferenceContext.js';

const client = tursoUrl ? createClient({ url: tursoUrl, authToken: tursoAuthToken }) : null;

// ─── Filter Schema ───────────────────────────────────────────────────────────
// Published dimensions the LLM can fill. All map to real indexed columns.
const FILTER_SCHEMA = {
  type: 'object',
  properties: {
    student_name: { type: 'string', description: 'Full or partial student name' },
    standard: { type: 'string', enum: ['6th', '7th', '8th', '9th', '10th', '11th', '12th'], description: 'Grade/standard' },
    subject: { type: 'string', description: 'Subject name e.g. Maths, Science, Chemistry, Physics' },
    exam_name: { type: 'string', description: 'Full or partial exam/test name' },
    exam_type: { type: 'string', enum: ['mcq', 'subjective', 'mixed'], description: 'Exam type' },
    exam_date_from: { type: 'string', format: 'date', description: 'Earliest exam date (YYYY-MM-DD)' },
    exam_date_to: { type: 'string', format: 'date', description: 'Latest exam date (YYYY-MM-DD)' },
    batch_name: { type: 'string', description: 'Batch name e.g. Regular Batch, A+ Batch' },
    performance_band: { type: 'string', enum: ['top', 'mid', 'low'], description: 'top = >=80%, mid = 50-79%, low = <50%' },
    min_score_pct: { type: 'number', description: 'Minimum score percentage (0-100)' },
    max_score_pct: { type: 'number', description: 'Maximum score percentage (0-100)' },
    limit: { type: 'integer', description: 'Max results to return (default 20)', default: 20 },
  },
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a query translator for a school exam grading platform.
Convert the user's natural language query into a JSON filter object.
Only use the properties defined in the schema. Omit properties the user didn't mention.
For relative dates ("last Sunday", "yesterday", "this week"), compute the actual date using today's date provided below.
For "maths" use "Maths", "science" use "Science", "chemistry" use "Chemistry", "physics" use "Physics".
If the query is ambiguous or not about exam data, return an empty object {}.
Respond with ONLY valid JSON, no explanation.

Today's date: {{TODAY}}

Filter schema:
${JSON.stringify(FILTER_SCHEMA, null, 2)}`;

// ─── LLM Call ────────────────────────────────────────────────────────────────
const NLQ_TIMEOUT_MS = 30_000;

async function translateQuery(naturalQuery, today) {
  if (nearPrivateEnabledForCurrentJob()) {
    const { result } = await callJsonModel({ prompt: naturalQuery, system: SYSTEM_PROMPT.replace('{{TODAY}}', today), maxTokens: 300, temperature: 0 });
    return result;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');
  // TODO(privacy): teacher queries can carry student names, and
  // 'openrouter/free' routes them to whichever free provider is up, with no
  // data-retention guarantee. Set NLQ_MODEL to a vetted paid model in Vercel;
  // nothing else in the codebase pins one to default to.
  const model = process.env.NLQ_MODEL || 'openrouter/free';

  const systemPrompt = SYSTEM_PROMPT.replace('{{TODAY}}', today);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: naturalQuery },
  ];
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://www.skyllai.com',
    'X-Title': 'Skyll AI',
  };

  // One deadline covers both attempts and reading the body.
  const signal = AbortSignal.timeout(NLQ_TIMEOUT_MS);

  // Try with response_format first; retry without if model doesn't support it
  let response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, temperature: 0, max_tokens: 300 }),
    signal,
  });

  if (!response.ok) {
    // Retry without response_format (some free providers don't support it)
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 300 }),
      signal,
    });
  }

  if (!response.ok) {
    // The upstream body is for our logs only; the caller never sees it.
    const text = await response.text().catch(() => '');
    throw new Error(`LLM error ${response.status}: ${text.slice(0, 500)}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty LLM response');
  // Extract JSON even if model wraps it in markdown
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in LLM response');
  return JSON.parse(jsonMatch[0]);
}

// ─── SQL Generation ──────────────────────────────────────────────────────────
// Reads canonical submissions/exams/students scoped by school_id. A row is
// listed once its report is published, as before, but the score is the live
// canonical one rather than a copy parsed out of every report payload.
export function buildSql(filter, schoolId) {
  const clauses = [
    'e.school_id = ?',
    "e.status NOT IN ('archived', 'held')",
    "s.status != 'archived'",
    "EXISTS (SELECT 1 FROM report_versions rv WHERE rv.submission_id = s.id AND rv.status = 'published')",
  ];
  const args = [schoolId];
  const nameExpr = 'COALESCE(st.display_name, ts.student_name)';
  const standardExpr = 'COALESCE(e.grade, t.grade)';
  const subjectExpr = 'COALESCE(sub.name, t.subject)';

  if (filter.student_name) {
    clauses.push(`${nameExpr} LIKE ?`);
    args.push(`%${filter.student_name}%`);
  }
  if (filter.standard) {
    clauses.push(`${standardExpr} = ?`);
    args.push(filter.standard);
  }
  if (filter.subject) {
    clauses.push(`LOWER(${subjectExpr}) LIKE ?`);
    args.push(`%${filter.subject.toLowerCase()}%`);
  }
  if (filter.exam_name) {
    clauses.push('e.name LIKE ?');
    args.push(`%${filter.exam_name}%`);
  }
  if (filter.exam_type) {
    clauses.push('e.exam_type = ?');
    args.push(filter.exam_type);
  }
  if (filter.exam_date_from) {
    clauses.push('e.exam_date >= ?');
    args.push(filter.exam_date_from);
  }
  if (filter.exam_date_to) {
    clauses.push('e.exam_date <= ?');
    args.push(filter.exam_date_to);
  }

  const pctExpr = 'CASE WHEN s.max_marks > 0 THEN (s.score * 100.0 / s.max_marks) ELSE NULL END';

  const hasScore = filter.performance_band || filter.min_score_pct != null || filter.max_score_pct != null;
  if (hasScore) {
    clauses.push('s.score IS NOT NULL AND s.max_marks > 0');
    if (filter.performance_band === 'top') clauses.push(`(${pctExpr}) >= 80`);
    if (filter.performance_band === 'mid') clauses.push(`(${pctExpr}) BETWEEN 50 AND 79.99`);
    if (filter.performance_band === 'low') clauses.push(`(${pctExpr}) < 50`);
    if (filter.min_score_pct != null) { clauses.push(`(${pctExpr}) >= ?`); args.push(filter.min_score_pct); }
    if (filter.max_score_pct != null) { clauses.push(`(${pctExpr}) <= ?`); args.push(filter.max_score_pct); }
  }

  const limit = Math.min(Math.max(Number(filter.limit) || 20, 1), 100);
  args.push(limit);

  const sql = `SELECT
    COALESCE(${nameExpr}, s.student_id) AS student_name,
    ${standardExpr} AS standard,
    ${subjectExpr} AS subject,
    COALESCE(e.name, '') AS exam_name,
    e.exam_date,
    e.exam_type,
    s.score,
    s.max_marks,
    ROUND(${pctExpr}, 1) AS pct
  FROM submissions s
  JOIN exams e ON e.id = s.exam_id
  LEFT JOIN tests t ON t.id = e.source_test_id
  LEFT JOIN subjects sub ON sub.id = e.subject_id
  LEFT JOIN students st ON st.id = s.student_id
  LEFT JOIN test_students ts ON ts.test_id = e.source_test_id AND ts.student_id = s.student_id
  WHERE ${clauses.join(' AND ')}
  ORDER BY e.exam_date DESC, student_name
  LIMIT ?`;

  return { sql, args };
}

/**
 * The school a query runs against, by canonical id. Everyone is pinned to the
 * school on their session; platform staff may name another school, which is
 * resolved to its id. There is no cross-school query.
 */
async function querySchoolId(actor, body) {
  const requested = actor.role === 'skyll_admin' ? String(body?.school || '').trim() : '';
  if (requested) return resolveSchoolId(client, requested);
  return actor.school_id || null;
}

// ─── Query Cache ─────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(schoolId, filter) {
  return `${schoolId}:${JSON.stringify(filter)}`;
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (!client) return res.status(500).json({ error: 'Database not configured' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureAuthTables();
    const actor = await requireUser(req, res, ['admin', 'skyll_admin', 'teacher']);
    if (!actor) return;

    const { q } = req.body || {};
    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.status(400).json({ error: 'Provide a query string in "q"' });
    }

    if (await checkRateLimit(actor.username)) {
      return res.status(429).json({ error: 'Too many queries. Wait a minute and try again.' });
    }

    const schoolId = await querySchoolId(actor, req.body);
    if (!schoolId) return res.status(404).json({ error: 'School not found' });
    const today = new Date().toISOString().slice(0, 10);

    // 1. Translate natural language → filter JSON
    let filter;
    try {
      const context = inferenceContextForUser(actor, 'query');
      await enablePrivateInferenceFor(context);
      filter = await runWithInferenceContext(context, () => translateQuery(q.trim(), today));
    } catch (error) {
      // Upstream detail stays in the logs; the UI falls back to manual filters.
      console.error('[query] translation failed:', error);
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return res.status(504).json({ error: 'Query translation timed out' });
      }
      return res.status(502).json({ error: 'Query translation failed' });
    }

    // 2. Validate: reject unknown keys
    const allowed = new Set(Object.keys(FILTER_SCHEMA.properties));
    for (const key of Object.keys(filter)) {
      if (!allowed.has(key)) delete filter[key];
    }

    // 3. Check cache
    const key = cacheKey(schoolId, filter);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return res.status(200).json({ filter, results: cached.results, cached: true });
    }

    // 4. Generate + execute SQL
    const { sql, args } = buildSql(filter, schoolId);
    const result = await client.execute({ sql, args });

    const results = result.rows.map((row) => ({
      studentName: row.student_name,
      standard: row.standard,
      subject: row.subject,
      examName: row.exam_name,
      examDate: row.exam_date,
      examType: row.exam_type,
      score: row.score != null ? Number(row.score) : null,
      maxMarks: row.max_marks != null ? Number(row.max_marks) : null,
      pct: row.pct != null ? Number(row.pct) : null,
    }));

    // 5. Cache
    cache.set(key, { results, at: Date.now() });
    if (cache.size > 200) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }

    return res.status(200).json({ filter, results, cached: false });
  } catch (error) {
    return internalError(res, error, 'query');
  }
}
