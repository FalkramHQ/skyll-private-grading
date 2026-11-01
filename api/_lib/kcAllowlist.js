// api/_lib/kcAllowlist.js
// Builds the per-exam knowledge-component allowlist: { byId, validIds }.
// KC rows carry board/grade/subject inherited from curriculum_standards
// (stored in the same format as tests.grade, e.g. '12th').
export async function buildKcAllowlist(db, { board, grade, subject }) {
  const result = await db.execute({
    sql: `SELECT id, kc_label, kc_slug, cognitive_level
          FROM knowledge_components
          WHERE board = ? AND grade = ? AND subject = ?`,
    args: [board, grade, subject],
  });
  const byId = {};
  const validIds = new Set();
  for (const row of result.rows) {
    byId[row.id] = { label: row.kc_label, slug: row.kc_slug, cognitive: row.cognitive_level };
    validIds.add(row.id);
  }
  return { byId, validIds };
}
