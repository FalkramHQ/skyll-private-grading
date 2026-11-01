// api/_lib/masteryEstimator.js
export const ESTIMATOR_VERSION = 'bb-v1';

export function betaPosterior(prior, signals) {
  let { alpha, beta } = { alpha: prior.alpha, beta: prior.beta };
  for (const s of signals) {
    const p = clamp01(s.p ?? (s.marksTotal ? s.marksObtained / s.marksTotal : 0));
    const w = (Number(s.confidence ?? 1)) * Math.min((Number(s.marksTotal) || 0) / 4, 1);
    alpha += w * p;
    beta += w * (1 - p);
  }
  return { alpha, beta };
}

export function thetaMean({ alpha, beta }) {
  const sum = alpha + beta;
  return sum > 0 ? alpha / sum : 0;
}

export function credibleInterval({ alpha, beta }) {
  const sum = alpha + beta;
  const mean = thetaMean({ alpha, beta });
  const wide = sum < 30;
  if (wide) return { mean, ciLow: null, ciHigh: null, wide: true };
  const variance = (alpha * beta) / (sum * sum * (sum + 1));
  const sd = Math.sqrt(variance);
  return { mean, ciLow: Math.max(0, mean - 1.96 * sd), ciHigh: Math.min(1, mean + 1.96 * sd), wide: false };
}

export function computeMastery(signals, { kcId, subject, priorAlpha = 1, priorBeta = 1 }) {
  const post = betaPosterior({ alpha: priorAlpha, beta: priorBeta }, signals);
  const ci = credibleInterval(post);
  return {
    kcId,
    subject,
    alpha: post.alpha,
    beta: post.beta,
    thetaMean: ci.mean,
    ciLow: ci.ciLow,
    ciHigh: ci.ciHigh,
    evidenceCount: signals.length,
    lastSignalAt: signals.reduce(
      (max, s) => (s.extractedAt && (max === null || s.extractedAt > max) ? s.extractedAt : max),
      null,
    ),
    wide: ci.wide,
  };
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// DB integration: load signals for a student+kc, compute, upsert
export async function runMasteryEstimation(db, { schoolId, studentId, kcId, subject, since = null }) {
  const args = [schoolId, studentId, kcId];
  let sinceClause = '';
  if (since) { sinceClause = ' AND es.extracted_at > ?'; args.push(since); }
  // json_each join: only signals explicitly tagged with this KC count.
  // Legacy untagged signals (kc_ids_json NULL) yield zero rows from json_each(NULL)
  // by design — the evidence gate means we never estimate from untagged data.
  const result = await db.execute({
    sql: `SELECT es.marks_obtained, es.marks_total, es.confidence, es.extracted_at
          FROM evidence_signals es, json_each(es.kc_ids_json) je
          WHERE es.school_id = ? AND es.student_id = ? AND es.status = 'active'
          AND es.marks_obtained IS NOT NULL AND es.marks_total IS NOT NULL
          AND je.value = ?
          ${sinceClause}`,
    args,
  });
  const kcRow = await db.execute({ sql: 'SELECT subject FROM knowledge_components WHERE id = ?', args: [kcId] });
  const subj = subject || kcRow.rows[0]?.subject || 'General';
  const signals = result.rows.map((r) => ({
    marksObtained: Number(r.marks_obtained), marksTotal: Number(r.marks_total),
    confidence: r.confidence == null ? 1 : Number(r.confidence), extractedAt: r.extracted_at,
  }));
  const m = computeMastery(signals, { kcId, subject: subj });
  const id = `mst_${kcId}_${studentId}`;
  const at = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO mastery_estimates (id, school_id, student_id, kc_id, subject, alpha, beta, theta_mean, ci_low, ci_high, evidence_count, last_signal_at, estimator_version, computed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(school_id, student_id, kc_id) DO UPDATE SET
            alpha = excluded.alpha, beta = excluded.beta, theta_mean = excluded.theta_mean,
            ci_low = excluded.ci_low, ci_high = excluded.ci_high, evidence_count = excluded.evidence_count,
            last_signal_at = excluded.last_signal_at, estimator_version = excluded.estimator_version, computed_at = excluded.computed_at`,
    args: [id, schoolId, studentId, kcId, subj, m.alpha, m.beta, m.thetaMean, m.ciLow, m.ciHigh, m.evidenceCount, m.lastSignalAt, ESTIMATOR_VERSION, at],
  });
  return m;
}
