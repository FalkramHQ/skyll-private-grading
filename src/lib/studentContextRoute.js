export function needsRequestedStudentContext(pathname, search = '') {
  const query = new URLSearchParams(search);
  return pathname.startsWith('/student/')
    || (query.has('student') && (pathname.startsWith('/subject/') || pathname === '/report'));
}
