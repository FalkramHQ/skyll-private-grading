// Sentry error monitoring initialization.
// Only activates if VITE_SENTRY_DSN is set — local dev without a DSN is a no-op.
import * as Sentry from '@sentry/react';

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;

export function initSentry() {
  if (!SENTRY_DSN) return;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0, // Disable performance tracing on Hobby plan
    denyUrls: [
      /extensions\//i, // browser extensions
      /chrome-extension:/i,
    ],
    ignoreErrors: [
      'ResizeObserver loop', // benign browser warning
      'Non-Error promise rejection captured',
    ],
  });
}

export { Sentry };
