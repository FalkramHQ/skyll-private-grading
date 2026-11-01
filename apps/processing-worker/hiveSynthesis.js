/**
 * Learning Hive DNA synthesis (plan2 Phase 2).
 * Additive, evidence-bound merge of deep signals into learner_dna / learner_dna_v2.
 */

import { randomUUID } from 'node:crypto';
import { callJsonModel } from '../../api/_lib/llmGateway.js';
import { generateLongitudinalDna } from '../../api/_lib/learnerDnaRefresh.js';

export const HIVE_SYNTHESIZER_VERSION = 'hive-synthesis-v1';
/** Do not re-queue a student whose synthesis failed within this window. */
export const HIVE_SYNTHESIS_FAILURE_COOLDOWN_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.HIVE_SYNTHESIS_FAILURE_COOLDOWN_MS || 24 * 60 * 60 * 1000),
);
const HIVE_SYNTHESIS_MAX_TOKENS = Math.max(2200, Number(process.env.HIVE_SYNTHESIS_MAX_TOKENS || 6000));

const MODE_IDS = new Set(['architect', 'pathfinder', 'maker', 'cartographer', 'calibrator', 'bridgebuilder']);
const MODE_STATES = new Set(['secure', 'developing', 'needs_practice', 'not_observed']);

function text(value) {
  return String(value || '').trim();
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export function buildSynthesisPrompt({ priorDna, signals, reportsSummary }) {
  return [
    'Synthesize an evidence-bound Learner DNA update from deep academic signals.',
    'Be additive: preserve grounded prior DNA unless new evidence clearly supersedes it.',
    'Every claim must cite signal evidence IDs (submission_question_id or question_number).',
    'Do not invent personality, motivation, or scores. Do not mention OCR/AI/reviewers.',
    'Use only these mode IDs: architect, pathfinder, maker, cartographer, calibrator, bridgebuilder.',
    'Dimension states must be one of: secure, developing, needs_practice, not_observed.',
    'Return JSON only with this shape:',
    '{"schema_version":2,"assessment_scope":{"level":"hive_synthesis","detail":""},"primary_mode":{"mode_id":"","title":"","description":"","evidence":"","evidence_ids":[""]},"growth_edge":{"mode_id":"","title":"","action":"","evidence":"","evidence_ids":[""]},"dimensions":[{"id":"","state":"","score":0,"evidence_question_ids":[""]}],"topic_mastery":[{"topic":"","pct":0,"evidence":"","evidence_ids":[""]}],"cross_exam_patterns":{"consistent_strengths":[],"recurring_gaps":[],"trajectory":"stable|improving|declining"},"next_move":{"title":"","action":"","evidence_ids":[""]},"synthesis_notes":""}',
    '',
    `Prior DNA: ${JSON.stringify(priorDna || {})}`,
    `Signals: ${JSON.stringify(signals)}`,
    `Report summary: ${JSON.stringify(reportsSummary || {})}`,
  ].join('\n');
}

export function normalizeSynthesizedDna(raw, { priorDna = null, signalIds = [] } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const prior = priorDna && typeof priorDna === 'object' ? priorDna : {};
  const fallbackIds = signalIds.map(text).filter(Boolean);

  const modeId = (value, fallback) => {
    const id = text(value).toLowerCase();
    return MODE_IDS.has(id) ? id : fallback;
  };

  const primaryModeId = modeId(source.primary_mode?.mode_id || source.primary_mode?.modeId, prior.primary_mode?.mode_id || 'pathfinder');
  const growthModeId = modeId(source.growth_edge?.mode_id || source.growth_edge?.modeId, prior.growth_edge?.mode_id || 'calibrator');

  const dimensionsSource = Array.isArray(source.dimensions) && source.dimensions.length
    ? source.dimensions
    : (Array.isArray(prior.dimensions) ? prior.dimensions : []);

  const dimensions = dimensionsSource.map((row) => {
    const id = modeId(row.id || row.mode_id, 'pathfinder');
    const state = MODE_STATES.has(text(row.state)) ? text(row.state) : 'not_observed';
    const score = row.score == null || row.score === '' ? null : Number(row.score);
    const evidenceIds = Array.isArray(row.evidence_question_ids)
      ? row.evidence_question_ids.map(text).filter(Boolean).slice(0, 12)
      : fallbackIds.slice(0, 8);
    return {
      id,
      mode_id: id,
      label: row.label || prior.dimensions?.find((d) => (d.id || d.mode_id) === id)?.label || id,
      state,
      score: Number.isFinite(score) ? score : null,
      evidence_count: evidenceIds.length,
      evidence_question_ids: evidenceIds,
    };
  });

  const ensureMode = (id) => {
    if (dimensions.some((d) => d.id === id)) return;
    dimensions.push({
      id,
      mode_id: id,
      label: id,
      state: 'not_observed',
      score: null,
      evidence_count: 0,
      evidence_question_ids: [],
    });
  };
  for (const id of MODE_IDS) ensureMode(id);

  const evidenceList = (value) => {
    const list = Array.isArray(value) ? value.map(text).filter(Boolean) : [];
    return list.length ? list.slice(0, 12) : fallbackIds.slice(0, 8);
  };

  return {
    schema_version: 2,
    assessment_scope: {
      level: 'hive_synthesis',
      detail: text(source.assessment_scope?.detail)
        || prior.assessment_scope?.detail
        || 'Synthesized from evidence signals.',
    },
    primary_mode: {
      mode_id: primaryModeId,
      title: text(source.primary_mode?.title) || prior.primary_mode?.title || primaryModeId,
      description: text(source.primary_mode?.description) || prior.primary_mode?.description || '',
      evidence: text(source.primary_mode?.evidence) || prior.primary_mode?.evidence || '',
      evidence_ids: evidenceList(source.primary_mode?.evidence_ids),
    },
    growth_edge: {
      mode_id: growthModeId,
      title: text(source.growth_edge?.title) || prior.growth_edge?.title || growthModeId,
      action: text(source.growth_edge?.action) || prior.growth_edge?.action || '',
      evidence: text(source.growth_edge?.evidence) || prior.growth_edge?.evidence || '',
      evidence_ids: evidenceList(source.growth_edge?.evidence_ids),
    },
    dimensions,
    topic_mastery: Array.isArray(source.topic_mastery)
      ? source.topic_mastery
      : (prior.topic_mastery || []),
    cross_exam_patterns: source.cross_exam_patterns && typeof source.cross_exam_patterns === 'object'
      ? source.cross_exam_patterns
      : (prior.cross_exam_patterns || { consistent_strengths: [], recurring_gaps: [], trajectory: 'stable' }),
    next_move: {
      title: text(source.next_move?.title) || prior.next_move?.title || 'Turn feedback into practice',
      action: text(source.next_move?.action) || prior.next_move?.action || '',
      evidence_ids: evidenceList(source.next_move?.evidence_ids),
    },
    synthesis_notes: text(source.synthesis_notes) || '',
    hive: {
      synthesizer_version: HIVE_SYNTHESIZER_VERSION,
      signal_count: fallbackIds.length,
    },
  };
}

export function diffDna(priorDna, nextDna) {
  const priorMode = priorDna?.primary_mode?.mode_id || null;
  const nextMode = nextDna?.primary_mode?.mode_id || null;
  const priorEdge = priorDna?.growth_edge?.mode_id || null;
  const nextEdge = nextDna?.growth_edge?.mode_id || null;
  return {
    primary_mode_changed: priorMode !== nextMode,
    growth_edge_changed: priorEdge !== nextEdge,
    prior_primary_mode: priorMode,
    next_primary_mode: nextMode,
    prior_growth_edge: priorEdge,
    next_growth_edge: nextEdge,
    next_move_changed: text(priorDna?.next_move?.action) !== text(nextDna?.next_move?.action),
  };
}

export async function loadStudentSignals(db, { schoolId, studentId, since = null, limit = 80 }) {
  const args = [schoolId, studentId];
  let sinceClause = '';
  if (since) {
    sinceClause = ' AND extracted_at > ?';
    args.push(since);
  }
  args.push(limit);
  const result = await db.execute({
    sql: `SELECT id, submission_id, submission_question_id, exam_id, question_number, topic,
                 marks_obtained, marks_total, concept_tags_json, misconception, strength,
                 method_note, next_practice, confidence, evidence_refs_json, extracted_at
          FROM evidence_signals
          WHERE school_id = ? AND student_id = ? AND status = 'active'${sinceClause}
          ORDER BY extracted_at DESC
          LIMIT ?`,
    args,
  });
  return result.rows.map((row) => ({
    id: row.id,
    submissionId: row.submission_id,
    submissionQuestionId: row.submission_question_id,
    examId: row.exam_id,
    questionNumber: row.question_number,
    topic: row.topic,
    marksObtained: row.marks_obtained,
    marksTotal: row.marks_total,
    conceptTags: parseJson(row.concept_tags_json, []),
    misconception: row.misconception,
    strength: row.strength,
    methodNote: row.method_note,
    nextPractice: row.next_practice,
    confidence: row.confidence,
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    extractedAt: row.extracted_at,
  }));
}

export async function loadPriorDna(db, { studentId, username }) {
  if (studentId) {
    const v2 = await db.execute({
      sql: 'SELECT dna_json FROM learner_dna_v2 WHERE student_id = ? LIMIT 1',
      args: [studentId],
    });
    if (v2.rows[0]?.dna_json) return parseJson(v2.rows[0].dna_json, null);
  }
  if (username) {
    const legacy = await db.execute({
      sql: 'SELECT dna_json FROM learner_dna WHERE username = ? LIMIT 1',
      args: [username],
    });
    if (legacy.rows[0]?.dna_json) return parseJson(legacy.rows[0].dna_json, null);
  }
  return null;
}

export async function loadReportsSummary(db, { username, studentId, limit = 8 }) {
  let rows = [];
  if (username) {
    rows = (await db.execute({
      sql: `SELECT payload_json, published_at FROM report_versions
            WHERE username = ? AND status = 'published'
            ORDER BY published_at DESC LIMIT ?`,
      args: [username, limit],
    })).rows;
  } else if (studentId) {
    rows = (await db.execute({
      sql: `SELECT payload_json, published_at FROM report_versions
            WHERE student_id = ? AND status = 'published'
            ORDER BY published_at DESC LIMIT ?`,
      args: [studentId, limit],
    })).rows;
  }
  const reports = rows.map((row) => parseJson(row.payload_json, null)).filter(Boolean);
  const longitudinal = reports.length >= 2 ? generateLongitudinalDna(reports) : null;
  return {
    examCount: reports.length,
    latestExam: reports[0]?.exams?.[0] || null,
    longitudinalAvailable: Boolean(longitudinal),
    baselineDna: longitudinal || reports[0]?.learner_dna || null,
  };
}

export async function resolveUsernameForStudent(db, studentId) {
  const linked = await db.execute({
    sql: `SELECT uc.login_id
          FROM student_user_links link
          JOIN user_credentials uc ON uc.user_id = link.user_id AND uc.is_primary = 1 AND uc.status = 'active'
          WHERE link.student_id = ? AND link.link_status = 'confirmed'
          LIMIT 1`,
    args: [studentId],
  });
  if (linked.rows[0]?.login_id) return linked.rows[0].login_id;
  const viaReport = await db.execute({
    sql: `SELECT username FROM report_versions
          WHERE student_id = ? AND username IS NOT NULL AND username != ''
          ORDER BY published_at DESC LIMIT 1`,
    args: [studentId],
  });
  return viaReport.rows[0]?.username || null;
}

export async function upsertSynthesizedDna(db, {
  schoolId,
  studentId,
  username,
  dna,
  examCount = 0,
  questionCount = 0,
  at = new Date().toISOString(),
}) {
  if (studentId && schoolId) {
    await db.execute({
      sql: `INSERT INTO learner_dna_v2 (student_id, school_id, dna_json, exam_count, question_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(student_id) DO UPDATE SET
              school_id = excluded.school_id,
              dna_json = excluded.dna_json,
              exam_count = excluded.exam_count,
              question_count = excluded.question_count,
              updated_at = excluded.updated_at`,
      args: [studentId, schoolId, JSON.stringify(dna), examCount, questionCount, at, at],
    });
  }
  if (username) {
    const profile = await db.execute({
      sql: 'SELECT school, student_name, class_name FROM learner_dna WHERE username = ? LIMIT 1',
      args: [username],
    }).catch(() => ({ rows: [] }));
    const existing = profile.rows[0] || {};
    await db.execute({
      sql: `INSERT INTO learner_dna (username, school, student_name, class_name, dna_json, exam_count, question_count, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
              dna_json = excluded.dna_json,
              exam_count = excluded.exam_count,
              question_count = excluded.question_count,
              updated_at = excluded.updated_at`,
      args: [
        username,
        existing.school || '',
        existing.student_name || username,
        existing.class_name || '',
        JSON.stringify(dna),
        examCount,
        questionCount,
        at,
      ],
    });
  }
}

export async function runHiveSynthesis(db, {
  schoolId,
  studentId,
  username = null,
  triggerSource = 'manual',
  callModel,
  since = null,
}) {
  const startedAt = new Date().toISOString();
  const runId = `dsyn_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const resolvedUsername = username || await resolveUsernameForStudent(db, studentId);
  const signals = await loadStudentSignals(db, { schoolId, studentId, since });
  const signalIds = signals.map((signal) => signal.id);
  const priorDna = await loadPriorDna(db, { studentId, username: resolvedUsername });
  const reportsSummary = await loadReportsSummary(db, { username: resolvedUsername, studentId });
  const baseline = priorDna || reportsSummary.baselineDna;

  if (!signals.length && !baseline) {
    await db.execute({
      sql: `INSERT INTO dna_synthesis_runs (
              id, school_id, student_id, status, trigger_source, input_signal_ids_json,
              prior_dna_json, result_dna_json, diff_json, model, synthesizer_version,
              error, started_at, completed_at, created_at
            ) VALUES (?, ?, ?, 'skipped', ?, '[]', NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
      args: [runId, schoolId, studentId, triggerSource, HIVE_SYNTHESIZER_VERSION, 'no_signals_or_baseline', startedAt, startedAt, startedAt],
    });
    return { skipped: true, reason: 'no_signals_or_baseline', runId };
  }

  let model = null;
  let raw = baseline;
  if (signals.length) {
    const prompt = buildSynthesisPrompt({
      priorDna: baseline,
      signals,
      reportsSummary: {
        examCount: reportsSummary.examCount,
        latestExam: reportsSummary.latestExam,
      },
    });
    let generated;
    try {
      generated = callModel
        ? await callModel({ prompt, signals, priorDna: baseline })
        : await callJsonModel({
          prompt,
          maxTokens: HIVE_SYNTHESIS_MAX_TOKENS,
          model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
          system: 'You synthesize evidence-bound Learner DNA. Return valid JSON only.',
        });
    } catch (error) {
      // Record the failure so the nightly scheduler can see it; otherwise the
      // same student is re-queued every tick and fails the same way forever.
      const failedAt = new Date().toISOString();
      await db.execute({
        sql: `INSERT INTO dna_synthesis_runs (
                id, school_id, student_id, status, trigger_source, input_signal_ids_json,
                prior_dna_json, result_dna_json, diff_json, model, synthesizer_version,
                error, started_at, completed_at, created_at
              ) VALUES (?, ?, ?, 'failed', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
        args: [
          runId,
          schoolId,
          studentId,
          triggerSource,
          JSON.stringify(signalIds),
          baseline ? JSON.stringify(baseline) : null,
          HIVE_SYNTHESIZER_VERSION,
          String(error?.message || error).slice(0, 2000),
          startedAt,
          failedAt,
          startedAt,
        ],
      }).catch(() => {});
      throw error;
    }
    raw = generated.result || generated;
    model = generated.model || null;
  }

  const resultDna = normalizeSynthesizedDna(raw, { priorDna: baseline, signalIds });
  const diff = diffDna(baseline, resultDna);
  const completedAt = new Date().toISOString();

  await upsertSynthesizedDna(db, {
    schoolId,
    studentId,
    username: resolvedUsername,
    dna: resultDna,
    examCount: reportsSummary.examCount || Number(baseline?.exam_breakdown?.length || 0),
    questionCount: signals.length,
    at: completedAt,
  });

  await db.execute({
    sql: `INSERT INTO dna_synthesis_runs (
            id, school_id, student_id, status, trigger_source, input_signal_ids_json,
            prior_dna_json, result_dna_json, diff_json, model, synthesizer_version,
            error, started_at, completed_at, created_at
          ) VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    args: [
      runId,
      schoolId,
      studentId,
      triggerSource,
      JSON.stringify(signalIds),
      baseline ? JSON.stringify(baseline) : null,
      JSON.stringify(resultDna),
      JSON.stringify(diff),
      model,
      HIVE_SYNTHESIZER_VERSION,
      startedAt,
      completedAt,
      startedAt,
    ],
  });

  return {
    skipped: false,
    runId,
    signalCount: signals.length,
    model,
    diff,
    dna: resultDna,
    username: resolvedUsername,
  };
}

export async function listStudentsNeedingSynthesis(db, { schoolId = null, limit = 25, now = Date.now() } = {}) {
  const args = [];
  let schoolClause = '';
  if (schoolId) {
    schoolClause = ' AND s.school_id = ?';
    args.push(schoolId);
  }
  // A student whose last synthesis attempt failed recently is skipped so a
  // poison input cannot be re-queued every scheduler tick (FLKRM: hive loop).
  const failureCutoff = new Date(now - HIVE_SYNTHESIS_FAILURE_COOLDOWN_MS).toISOString();
  args.push(failureCutoff);
  args.push(limit);
  const result = await db.execute({
    sql: `SELECT s.school_id, s.student_id, MAX(s.extracted_at) AS latest_signal_at,
                 (SELECT MAX(r.completed_at) FROM dna_synthesis_runs r
                  WHERE r.student_id = s.student_id AND r.status = 'succeeded') AS latest_synthesis_at
          FROM evidence_signals s
          JOIN school_feature_flags f
            ON f.school_id = s.school_id
           AND f.feature_key = 'deep_signals'
           AND f.enabled = 1
          WHERE s.status = 'active'${schoolClause}
            AND NOT EXISTS (
              SELECT 1 FROM dna_synthesis_runs fr
              WHERE fr.student_id = s.student_id
                AND fr.status = 'failed'
                AND COALESCE(fr.completed_at, fr.started_at) > ?
            )
          GROUP BY s.school_id, s.student_id
          HAVING latest_synthesis_at IS NULL OR latest_signal_at > latest_synthesis_at
          ORDER BY latest_signal_at ASC
          LIMIT ?`,
    args,
  });
  return result.rows;
}
