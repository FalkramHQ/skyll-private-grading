export async function syncTestUploadStatus(db, testId, now = new Date().toISOString()) {
  const incomplete = await db.execute({
    sql: "SELECT 1 AS has_pending FROM file_assets WHERE test_id = ? AND status IN ('registered', 'uploading') LIMIT 1",
    args: [testId],
  });
  const assets = await db.execute({ sql: "SELECT kind, COUNT(*) AS count FROM file_assets WHERE test_id = ? AND status = 'uploaded' GROUP BY kind", args: [testId] });
  const counts = Object.fromEntries(assets.rows.map((row) => [row.kind, Number(row.count)]));
  const ready = !incomplete.rows.length && Boolean(counts.question_paper && counts.answer_key && counts.answer_sheet);
  const nextStatus = ready ? 'ready_for_processing' : 'uploading';
  // Only rewrite tests still in the upload phase. OCR/grading/review statuses
  // must not be yanked back to uploading when a leftover asset is completed.
  await db.execute({
    sql: `UPDATE tests SET status = ?, updated_at = ?
          WHERE id = ? AND status IN ('uploading', 'ready_for_processing')`,
    args: [nextStatus, now, testId],
  });
  return { counts, ready, status: nextStatus };
}
