/**
 * Shared CORS + preflight helper for Vercel serverless API routes.
 * Usage:
 *   import { handleCors } from './_lib/cors.js';
 *   export default async function handler(req, res) {
 *     if (handleCors(req, res)) return; // preflight handled
 *     ...
 *   }
 */

const DEFAULT_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const DEFAULT_HEADERS = 'Content-Type, Authorization';

// Production origins that are allowed to make credentialed (cookie-based)
// requests to the API. In development, localhost variants are also allowed
// so the Vite dev server can talk to the API.
const PRODUCTION_ORIGINS = new Set([
  'https://www.skyllai.com',
  'https://skyllai.com',
]);

const DEV_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:3456',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3456',
]);

function allowedOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return null; // same-origin or non-browser — no CORS header needed
  if (PRODUCTION_ORIGINS.has(origin)) return origin;
  if (process.env.NODE_ENV !== 'production' && DEV_ORIGINS.has(origin)) return origin;
  return null;
}

/**
 * Sets CORS headers on every response and short-circuits OPTIONS preflights.
 * Only known origins receive Access-Control-Allow-Origin; all others are
 * denied credentialed access.
 * @returns {boolean} true if the request was a preflight (caller should return).
 */
export function handleCors(req, res, { methods = DEFAULT_METHODS, headers = DEFAULT_HEADERS } = {}) {
  const origin = allowedOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', headers);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
