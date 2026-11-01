/**
 * Fire-and-forget intake analytics. Never throws into UI flows.
 */
export function trackIntakeEvent(api, accessToken, eventType, eventData = {}) {
  if (!api || !accessToken || !eventType) return;
  Promise.resolve(
    api('/api/auth/events', {
      method: 'POST',
      body: JSON.stringify({ eventType, eventData, platform: 'intake' }),
    }, accessToken),
  ).catch(() => {});
}
