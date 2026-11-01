export function answerSheetUrl({ subject, page, studentUsername, testId } = {}) {
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (page !== undefined && page !== null) params.set('page', String(page));
  if (studentUsername) params.set('student', studentUsername);
  if (testId) params.set('testId', testId);
  return `/api/student-answer-sheet?${params.toString()}`;
}

export function reviewAnswerSheetUrl({ testId, testStudentId, subject, page }) {
  const params = new URLSearchParams({
    testId: String(testId),
    testStudentId: String(testStudentId),
    subject: String(subject || ''),
    page: String(page),
  });
  return `/api/student-answer-sheet?${params.toString()}`;
}
