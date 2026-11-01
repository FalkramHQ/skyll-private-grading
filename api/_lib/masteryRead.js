export async function loadMasteryEstimates(db, { schoolId, studentId, subject = null } = {}) {
  if (!db || !schoolId || !studentId) return [];
  const args = [schoolId, studentId];
  let subjectClause = '';
  if (subject) {
    subjectClause = 'AND subject = ?';
    args.push(subject);
  }
  const result = await db.execute({
    sql: `SELECT me.kc_id, kc.kc_label, kc.curriculum_standard_id, me.subject, me.alpha, me.beta, me.theta_mean, me.ci_low, me.ci_high, me.evidence_count, me.last_signal_at
          FROM mastery_estimates me
          LEFT JOIN knowledge_components kc ON kc.id = me.kc_id
          WHERE me.school_id = ? AND me.student_id = ? ${subjectClause}
          ORDER BY me.theta_mean ASC, me.kc_id`,
    args,
  }).catch(() => ({ rows: [] }));
  return (result.rows || []).map((r) => ({
    kcId: r.kc_id,
    kcLabel: r.kc_label || null,
    curriculumStandardId: r.curriculum_standard_id || null,
    subject: r.subject,
    alpha: Number(r.alpha) || 0,
    beta: Number(r.beta) || 0,
    thetaMean: Number(r.theta_mean) || 0,
    ciLow: r.ci_low == null ? null : Number(r.ci_low),
    ciHigh: r.ci_high == null ? null : Number(r.ci_high),
    wide: r.ci_low == null || r.ci_high == null,
    evidenceCount: Number(r.evidence_count) || 0,
    lastSignalAt: r.last_signal_at,
  }));
}
