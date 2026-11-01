// Server-only configuration. The legacy VITE_* fallback keeps deployed
// environments working during the one-time Vercel variable migration.
export const tursoUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL;
export const tursoAuthToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
