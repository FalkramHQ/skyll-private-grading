export function isCanonicalAnswerSheetRequest(query = {}) {
  return Boolean(query.testId || query.testStudentId);
}
