// Shared Turso (libSQL) client singleton for API endpoints.
// Avoids each endpoint creating its own client instance.
import { createClient } from '@libsql/client/web';
import { tursoAuthToken, tursoUrl } from './env.js';

export const client = tursoUrl ? createClient({ url: tursoUrl, authToken: tursoAuthToken }) : null;
