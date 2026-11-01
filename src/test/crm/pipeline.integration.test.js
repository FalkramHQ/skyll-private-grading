// Runs migrations 059 + 060 on a temporary SQLite file: lazy seeding under
// concurrency, versioned renames/reorders, and category immutability.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

const require = createRequire(import.meta.url);
const { statements: migration059 } = require('../../../scripts/migrations/059_crm_access_audit.cjs');
const { statements: migration060 } = require('../../../scripts/migrations/060_crm_pipeline.cjs');
// 062 for lead counts per stage, 067 for the pipeline's conversion requirements.
const { statements: migration062 } = require('../../../scripts/migrations/062_crm_leads.cjs');
const { statements: migration067 } = require('../../../scripts/migrations/067_crm_pipeline_requirements.cjs');

const state = vi.hoisted(() => ({ db: null }));
const auth = vi.hoisted(() => ({ database: vi.fn(() => state.db), sessionForRequest: vi.fn() }));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);

const { handleCrmRequest } = await import('../../../server/crm/router.js');

const admin = { user_id: 'usr_admin', username: 'a_admin', role: 'admin', school_id: 'sch_a', school: 'School A' };
const teacher = { user_id: 'usr_teacher', username: 'a_teacher', role: 'teacher', school_id: 'sch_a', school: 'School A' };
const otherAdmin = { user_id: 'usr_admin_b', username: 'b_admin', role: 'admin', school_id: 'sch_b', school: 'School B' };

let dir;

async function call(actor, method, route, body) {
  auth.sessionForRequest.mockResolvedValue(actor);
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handleCrmRequest({ method, headers: {}, query: {}, body }, res, route.split('/'));
  return res;
}

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-pipeline-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch(['CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT)', "CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata')", ...migration059, ...migration060, ...migration062, ...migration067], 'write');
});

describe('CRM pipeline settings (real SQLite)', () => {
  it('seeds the 8 default stages once, even under parallel first requests', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => call(admin, 'GET', 'settings/pipeline')));
    expect(responses.every((res) => res.statusCode === 200)).toBe(true);
    const pipeline = responses[0].body;
    expect(pipeline.version).toBe(1);
    expect(pipeline.stages.map((stage) => [stage.name, stage.category])).toEqual([
      ['New inquiry', 'open'], ['Contacted', 'open'], ['Qualified', 'open'], ['Trial scheduled', 'open'],
      ['Application', 'applicant'], ['Payment pending', 'applicant'], ['Enrolled', 'won'], ['Lost', 'lost'],
    ]);
    const counts = await state.db.execute('SELECT (SELECT COUNT(*) FROM crm_pipelines) AS p, (SELECT COUNT(*) FROM crm_pipeline_stages) AS s');
    expect([Number(counts.rows[0].p), Number(counts.rows[0].s)]).toEqual([1, 8]);
  });

  it('keeps schools separate: another school gets its own pipeline and cannot touch ours', async () => {
    const mine = (await call(admin, 'GET', 'settings/pipeline')).body;
    const theirs = (await call(otherAdmin, 'GET', 'settings/pipeline')).body;
    expect(theirs.id).not.toBe(mine.id);
    const stage = mine.stages[0];
    const res = await call(otherAdmin, 'POST', 'settings/pipeline/rename', { stageId: stage.id, name: 'Hijacked', expectedVersion: stage.version });
    expect(res.statusCode).toBe(404);
  });

  it('renames with a version check, audits it, and returns 409 to a stale second tab', async () => {
    const { stages } = (await call(admin, 'GET', 'settings/pipeline')).body;
    const stage = stages[3];
    const first = await call(admin, 'POST', 'settings/pipeline/rename', { stageId: stage.id, name: 'Demo class booked', expectedVersion: 1 });
    expect(first.statusCode).toBe(200);
    expect(first.body.stages[3]).toEqual(expect.objectContaining({ name: 'Demo class booked', category: 'open', version: 2 }));

    const stale = await call(admin, 'POST', 'settings/pipeline/rename', { stageId: stage.id, name: 'Trial', expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error).toEqual(expect.objectContaining({ code: 'version_conflict', details: { currentVersion: 2 } }));

    const audit = await state.db.execute('SELECT action, summary_json FROM crm_audit_events');
    expect(audit.rows).toHaveLength(1);
    expect(JSON.parse(audit.rows[0].summary_json)).toEqual({ change: 'stage_renamed', stageId: stage.id, fromName: 'Trial scheduled', toName: 'Demo class booked' });
  });

  it('never lets a client change a stage category or reuse a name', async () => {
    const { stages } = (await call(admin, 'GET', 'settings/pipeline')).body;
    const open = stages[0];
    const category = await call(admin, 'POST', 'settings/pipeline/rename', { stageId: open.id, name: 'Won now', category: 'won', expectedVersion: 1 });
    expect(category.statusCode).toBe(422);
    const duplicate = await call(admin, 'POST', 'settings/pipeline/rename', { stageId: open.id, name: 'contacted', expectedVersion: 1 });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.body.error.code).toBe('duplicate_name');
    const after = (await call(admin, 'GET', 'settings/pipeline')).body.stages[0];
    expect(after).toEqual(expect.objectContaining({ name: 'New inquiry', category: 'open', version: 1 }));
  });

  it('reorders all stages atomically and rejects a stale or partial reorder', async () => {
    const pipeline = (await call(admin, 'GET', 'settings/pipeline')).body;
    const reversed = [...pipeline.stages].reverse().map((stage) => stage.id);
    const ok = await call(admin, 'POST', 'settings/pipeline/reorder', { stageIds: reversed, expectedVersion: 1 });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.version).toBe(2);
    expect(ok.body.stages.map((stage) => stage.id)).toEqual(reversed);

    const stale = await call(admin, 'POST', 'settings/pipeline/reorder', { stageIds: pipeline.stages.map((stage) => stage.id), expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error.details).toEqual({ currentVersion: 2 });
    const unchanged = (await call(admin, 'GET', 'settings/pipeline')).body;
    expect(unchanged.stages.map((stage) => stage.id)).toEqual(reversed);

    const partial = await call(admin, 'POST', 'settings/pipeline/reorder', { stageIds: reversed.slice(1), expectedVersion: 2 });
    expect(partial.statusCode).toBe(422);
    const audit = await state.db.execute("SELECT COUNT(*) AS n FROM crm_audit_events WHERE action = 'pipeline.changed'");
    expect(Number(audit.rows[0].n)).toBe(1);
  });

  it('lets teachers read stages but not change them', async () => {
    const read = await call(teacher, 'GET', 'settings/pipeline');
    expect(read.statusCode).toBe(200);
    const stage = read.body.stages[0];
    expect((await call(teacher, 'POST', 'settings/pipeline/rename', { stageId: stage.id, name: 'X', expectedVersion: 1 })).statusCode).toBe(403);
    expect((await call(teacher, 'POST', 'settings/pipeline/reorder', { stageIds: [stage.id], expectedVersion: 1 })).statusCode).toBe(403);
  });
});
