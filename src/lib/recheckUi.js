function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

export function canRequestRecheckForReport({
  viewerRole,
  viewerUsername,
  viewerSchool,
  reportUsername,
  reportSchool,
} = {}) {
  if (viewerRole === 'student') {
    return Boolean(reportUsername && normalized(viewerUsername) === normalized(reportUsername));
  }
  if (viewerRole === 'skyll_admin') return Boolean(reportUsername);
  if (viewerRole !== 'admin' || !reportUsername) return false;
  if (!viewerSchool || !reportSchool) return true;
  return normalized(viewerSchool) === normalized(reportSchool);
}

export function mergeRecheckResponse(current = [], request) {
  if (!request?.id) return current;
  return [request, ...current.filter((item) => item.id !== request.id)];
}
