export function studentPaperStatus(input = {}) {
  const expected = Number(input.expectedPageCount) || 0;
  const uploaded = Number(input.uploadedCount ?? input.uploadedCount) || 0;
  if (expected > 0) return uploaded === expected ? 'uploaded' : 'expected';
  return uploaded > 0 ? 'uploaded' : 'expected';
}

export function incompleteStudentPapersSql() {
  return `SELECT ts.id FROM test_students ts
          WHERE ts.test_id = ?
            AND COALESCE(ts.expected_page_count, 0) > 0
            AND (
              SELECT COUNT(*) FROM file_assets a
              WHERE a.test_id = ts.test_id
                AND a.test_student_id = ts.id
                AND a.kind = 'answer_sheet'
                AND a.status = 'uploaded'
            ) != ts.expected_page_count
          LIMIT 1`;
}
