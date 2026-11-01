import { describe, expect, it, vi } from 'vitest';
import { createAlerter, formatTitle, isLarkWebhook, larkSignature } from '../../shared/alerts.js';
import { createHousekeeper, runHousekeeping } from '../../apps/processing-worker/housekeeping.js';

describe('worker alerts', () => {
  it('is a no-op without a webhook URL', async () => {
    const fetchImpl = vi.fn();
    const alerter = createAlerter({ webhookUrl: '', fetchImpl });
    expect(alerter.enabled).toBe(false);
    expect(await alerter.send('job_failed', { jobId: 'j1' })).toEqual({ sent: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a Slack-compatible payload and rate-limits repeats for the same test', async () => {
    let clock = 1_000_000;
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const alerter = createAlerter({ webhookUrl: 'https://hooks.example/abc', fetchImpl, now: () => clock, windowMs: 60_000, env: 'abc123', log: () => {} });

    const first = await alerter.send('job_failed', { jobId: 'j1', type: 'build_rubric', testId: 't1', school: 'Alpha', attempts: 3, error: 'boom' });
    expect(first).toEqual({ sent: true });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.text).toContain('job failed after 3 attempts');
    expect(body.text).toContain('Alpha · build_rubric · t1');
    expect(body.skyll).toMatchObject({ event: 'job_failed', worker_version: 'abc123', jobId: 'j1', testId: 't1' });

    const repeat = await alerter.send('job_failed', { jobId: 'j2', type: 'build_rubric', testId: 't1', attempts: 3, error: 'boom again' });
    expect(repeat).toEqual({ sent: false, reason: 'rate_limited' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 61_000;
    expect(await alerter.send('job_failed', { jobId: 'j3', testId: 't1' })).toEqual({ sent: true });
    // a different test is not throttled by the first one
    expect(await alerter.send('job_failed', { jobId: 'j4', testId: 't2' })).toEqual({ sent: true });
  });

  it('never throws when the webhook is down', async () => {
    const log = vi.fn();
    const alerter = createAlerter({ webhookUrl: 'https://hooks.example/abc', fetchImpl: async () => { throw new Error('ECONNRESET'); }, log });
    expect(await alerter.send('poll_failed', { error: 'x' }, { key: 'poll' })).toEqual({ sent: false, reason: 'network' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'alert_delivery_failed' }));
  });

  it('formats titles for known events', () => {
    expect(formatTitle('job_lease_exhausted', { type: 'grade_submission', testId: 't9' })).toContain('repeated lease expiry');
    expect(formatTitle('worker_started', { workerVersion: 'deadbee' })).toBe('Skyll worker started (deadbee)');
  });

  describe('Lark webhook', () => {
    const larkUrl = 'https://open.larksuite.com/open-apis/bot/v2/hook/abc';
    const ok = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, msg: 'success' }) });

    it('recognises Lark and Feishu bot URLs only', () => {
      expect(isLarkWebhook(larkUrl)).toBe(true);
      expect(isLarkWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/abc')).toBe(true);
      expect(isLarkWebhook('https://hooks.slack.com/services/x')).toBe(false);
      expect(isLarkWebhook('https://evil.example/open-apis/bot/v2/hook/abc')).toBe(false);
      expect(isLarkWebhook('not a url')).toBe(false);
    });

    it('sends a Lark text message with the headline and details', async () => {
      const fetchImpl = vi.fn(ok);
      const alerter = createAlerter({ webhookUrl: larkUrl, fetchImpl, env: 'abc123', log: () => {} });
      expect(await alerter.send('score_mismatch', { school: 'Alpha', testId: 't1', submissionId: 's1', storedScore: 8.5, expectedScore: 21.5 })).toEqual({ sent: true });
      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(body.msg_type).toBe('text');
      expect(body.content.text).toContain('stored score does not match the question marks (Alpha · t1)');
      expect(body.content.text).toContain('storedScore: 8.5');
      expect(body.content.text).toContain('expectedScore: 21.5');
      expect(body.sign).toBeUndefined();
    });

    it('signs the message when a secret is set', async () => {
      const fetchImpl = vi.fn(ok);
      const alerter = createAlerter({ webhookUrl: larkUrl, webhookSecret: 's3cret', fetchImpl, now: () => 1_700_000_000_000, log: () => {} });
      await alerter.send('poll_failed', { error: 'x' }, { key: 'poll' });
      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(body.timestamp).toBe('1700000000');
      expect(body.sign).toBe(larkSignature('1700000000', 's3cret'));
    });

    it('treats a non-zero Lark code as a failed delivery', async () => {
      const log = vi.fn();
      const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ code: 19021, msg: 'sign match fail' }) });
      const alerter = createAlerter({ webhookUrl: larkUrl, fetchImpl, log });
      expect(await alerter.send('poll_failed', { error: 'x' }, { key: 'poll' })).toEqual({ sent: false, reason: 'lark_19021' });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'alert_delivery_failed', lark_code: 19021 }));
    });
  });
});

describe('worker housekeeping', () => {
  it('deletes stopped and silent heartbeats and long-expired sessions, nothing else', async () => {
    const execute = vi.fn(async ({ sql }) => ({ rowsAffected: sql.includes('worker_heartbeats') ? 2 : 5 }));
    const now = Date.parse('2026-10-07T00:00:00.000Z');
    const result = await runHousekeeping({ execute }, { now, heartbeatRetentionMs: 7 * 86_400_000, sessionRetentionMs: 30 * 86_400_000 });
    expect(result).toEqual({ heartbeatsDeleted: 4, sessionsDeleted: 5 });
    const statements = execute.mock.calls.map(([arg]) => arg);
    expect(statements.every((s) => s.sql.startsWith('DELETE FROM worker_heartbeats') || s.sql.startsWith('DELETE FROM sessions'))).toBe(true);
    expect(statements[0].args[0]).toBe('2026-09-30T00:00:00.000Z');
    expect(statements[2].args[0]).toBe('2026-09-07T00:00:00.000Z');
    expect(statements.some((s) => /processing_jobs|submissions|report_versions/.test(s.sql))).toBe(false);
  });

  it('runs at most once per interval and swallows errors', async () => {
    let clock = 0;
    const execute = vi.fn(async () => ({ rowsAffected: 0 }));
    const onError = vi.fn();
    const housekeeping = createHousekeeper({ execute }, { intervalMs: 60_000, now: () => clock, log: () => {}, onError });
    expect(await housekeeping()).toEqual({ heartbeatsDeleted: 0, sessionsDeleted: 0 });
    expect(await housekeeping()).toBeNull();
    clock = 60_001;
    execute.mockRejectedValueOnce(new Error('locked'));
    expect(await housekeeping()).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
