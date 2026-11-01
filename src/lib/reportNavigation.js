export function getReportBackUrl(searchParams) {
  const backParams = new URLSearchParams();
  const examId = searchParams.get('exam');
  const tab = searchParams.get('tab');
  const subject = searchParams.get('subject');
  const cls = searchParams.get('cls');
  const requestedStudentUsername = searchParams.get('student');

  if (tab) backParams.set('tab', tab);
  if (subject) backParams.set('subject', subject);
  if (cls) backParams.set('cls', cls);
  if (examId) backParams.set('exam', examId);

  const query = backParams.toString();
  const path = requestedStudentUsername
    ? `/student/${encodeURIComponent(requestedStudentUsername)}`
    : '/dashboard';
  return `${path}${query ? `?${query}` : ''}`;
}

// Keep the complete report context while moving between subject reports.
export function getSubjectReportUrl(subjectId, searchParams) {
  const params = new URLSearchParams(searchParams);
  if (!params.get('exam')) params.set('exam', 'term1');
  return `/subject/${encodeURIComponent(subjectId)}?${params.toString()}`;
}
