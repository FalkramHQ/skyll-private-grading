// @vitest-environment node
// FLKRM-386: role × school regression matrix. Every route registered as
// `matrix` is called as each of seven actors against School A's records, on a
// fresh database built from the production schema. Real handlers and services
// run; only the session, the DB client, storage, LLM calls, CORS and rate
// limiting are mocked. School B actors must never receive School A's data.
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTORS, ALPHA_SECRET, createTwoSchoolDatabase } from './matrix/twoSchoolFixture.js';
import { MATRIX_ROUTES } from './matrix/matrixRoutes.js';

const state = vi.hoisted(() => ({ db: null, user: null }));

vi.mock('@libsql/client/web', () => ({
  // Several routes build their client once at import; forward to this case's DB.
  createClient: () => ({
    execute: (...args) => state.db.execute(...args),
    batch: (...args) => state.db.batch(...args),
  }),
}));
vi.mock('../../api/_lib/env.js', () => ({ tursoUrl: 'file:role-school-matrix', tursoAuthToken: 'token' }));
vi.mock('../../api/_lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  database: () => state.db,
  ensureAuthTables: async () => {},
  requireUser: async (_req, res, roles) => {
    if (!state.user) { res.status(401).json({ error: 'Sign in required' }); return null; }
    if (roles && !roles.includes(state.user.role)) { res.status(403).json({ error: 'forbidden' }); return null; }
    return state.user;
  },
}));
vi.mock('../../api/_lib/cors.js', () => ({ handleCors: () => false }));
vi.mock('../../api/_lib/rateLimit.js', () => ({ checkRateLimit: async () => false }));
vi.mock('../../api/_lib/intake.js', async (importOriginal) => ({ ...(await importOriginal()), ensureIntakeTables: async () => {} }));
vi.mock('../../api/_lib/storage.js', async (importOriginal) => ({
  ...(await importOriginal()),
  // Stored bytes carry the owning school's marker, so serving the wrong
  // school's file shows up in the body.
  getObject: async ({ key }) => (key === 'billing/invoice-signature.png' ? {
    // Invoice PDFs (FLKRM-487) need a real PNG signature: a 1×1 pixel.
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
  } : {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.from(String(key).includes('alpha') ? `${ALPHA_SECRET} bytes` : 'BETA_SECRET bytes'),
  }),
  createUploadUrl: async () => ({ url: 'https://storage.test/upload', headers: {} }),
  createDownloadUrl: async () => 'https://storage.test/download',
  deleteObject: async () => ({ ok: true, status: 200 }),
  putObject: async () => ({ ok: true }),
}));
vi.mock('../../api/_lib/teacherAi.js', () => {
  // LLM-backed helpers: answer with School A's marker only when asked about School A.
  const answer = async (_db, { schoolId } = {}) => ({ text: schoolId === 'sch_a' ? `${ALPHA_SECRET} answer` : 'other school answer' });
  return {
    runTeacherCopilot: answer,
    generateLessonPlan: answer,
    generateQuiz: answer,
    generateBriefing: answer,
    generateInterventions: answer,
    generateParentReport: answer,
  };
});

const { resetSchoolCache } = await import('../../api/_lib/canonicalSubmissions.js');

process.env.OPENROUTER_API_KEY = 'test-key';
globalThis.fetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: '{}' } }] }),
  text: async () => '{}',
}));

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; return this; },
    getHeader(name) { return this.headers[name]; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    end(body) { if (body !== undefined) this.body = Buffer.isBuffer(body) ? body.toString() : body; return this; },
  };
}

const text = (body) => (typeof body === 'string' ? body : JSON.stringify(body ?? null));
const DENY = [401, 403, 404];
const SCHOOL_B_ACTORS = new Set(['teacherB', 'adminB']);

let errors = [];
beforeEach(async () => {
  resetSchoolCache();
  state.db = await createTwoSchoolDatabase();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function call(row, actorKey) {
  state.user = ACTORS[actorKey];
  const handler = await row.load();
  const res = response();
  const { method, query = {}, body } = row.request;
  await handler({ method, query: { ...query }, body: body ? structuredClone(body) : undefined, headers: {}, url: '/' }, res);
  return res;
}

describe('role × school matrix (FLKRM-386)', () => {
  for (const row of MATRIX_ROUTES) {
    describe(`${row.route}${row.name ? ` — ${row.name}` : ''}`, () => {
      for (const [actorKey, expected] of Object.entries(row.expect)) {
        it(`${actorKey}: ${expected}`, async () => {
          const res = await call(row, actorKey);
          const body = text(res.body);
          const status = res.statusCode;
          const context = `${row.route} as ${actorKey} → ${status} ${body.slice(0, 200)}${errors.length ? ` | ${errors[0].slice(0, 200)}` : ''}`;

          // The invariant the whole epic is about.
          if (SCHOOL_B_ACTORS.has(actorKey)) expect(body.includes(ALPHA_SECRET), `School A data leaked: ${context}`).toBe(false);

          if (expected === 'allow') {
            expect(status, context).toBeGreaterThanOrEqual(200);
            expect(status, context).toBeLessThan(300);
            expect(body.includes(ALPHA_SECRET), `fixture not reached: ${context}`).toBe(true);
          } else if (expected === 'reach') {
            expect([...DENY].includes(status) || status >= 500, context).toBe(false);
          } else if (expected === 'scoped') {
            expect(status, context).toBeLessThan(500);
            expect(body.includes(ALPHA_SECRET), context).toBe(false);
          } else {
            expect(row.denyStatuses || DENY, context).toContain(status);
            expect(body.includes(ALPHA_SECRET), context).toBe(false);
          }
        });
      }
    });
  }
});
