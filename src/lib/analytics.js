/**
 * Fire-and-forget product analytics. Never throws into UI flows.
 * Uses fetch (not sendBeacon) so session cookies + JSON body parse reliably.
 */
export function track(eventType, eventData = {}, { platform = 'web' } = {}) {
  if (!eventType || typeof window === 'undefined') return;
  fetch('/api/auth/events', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType, eventData, platform }),
    keepalive: true,
  }).catch(() => {});
}

export function getProductMetrics() {
  return fetch('/api/auth/events', { credentials: 'same-origin' })
    .then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not load product metrics');
      return payload;
    });
}
