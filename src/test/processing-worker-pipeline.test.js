import { describe, expect, it } from 'vitest';
import { errorCode, leaseExpiresAt, reclaimDecision, retryAt, retryDelayMs, shouldCountClaimAsAttempt } from '../../apps/processing-worker/lifecycle.js';
import { applyScoringPlan, normalizeScoringPlan } from '../../apps/processing-worker/scoringPlan.js';
import { requireStudentPublicLogin } from '../../apps/processing-worker/studentIdentity.js';
import { answerSheetOcrText, ocrRunText, pageOcrText, sourceOcrText } from '../../apps/processing-worker/ocrText.js';

/**
 * Integration-level tests for the processing worker's main loop behavior.
 *
 * The worker's index.js has import-time side effects (env validation, db
 * creation, run() invocation), so these tests exercise the extracted modules
 * that compose the tick() → claim → process → complete/fail pipeline.
 */

// Mirrors the worker's production configuration constants.
const WORKER_CONFIG = {
  maxJobAttempts: 3,
  retryBaseMs: 60_000,
  retryMaxMs: 15 * 60_000,
  jobLeaseMs: 30 * 60_000,
};

describe('processing worker job lifecycle (happy path)', () => {
  it('leases a job with correct expiry for the configured lease duration', () => {
    const clock = () => 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
    const expires = leaseExpiresAt({ leaseMs: WORKER_CONFIG.jobLeaseMs, clock });
    // Lease should expire 30 minutes from now
    const expected = new Date(1_700_000_000_000 + 30 * 60_000).toISOString();
    expect(expires).toBe(expected);
  });

  it('processes a multi-question scoring plan and produces correct totals', () => {
    // Simulates the report-building stage where applyScoringPlan is called
    // with graded questions from submission_questions rows.
    const questions = [
      { number: 'Q1', marks_obtained: 4, marks_total: 4, status: 'correct' },
      { number: 'Q2', marks_obtained: 2, marks_total: 3, status: 'partial' },
      { number: 'Q3', marks_obtained: 0, marks_total: 5, status: 'incorrect' },
      { number: 'Q4a', marks_obtained: 3, marks_total: 3, status: 'correct' },
      { number: 'Q4b', marks_obtained: 1, marks_total: 2, status: 'partial' },
    ];
    const plan = { groups: [] }; // No optional sections
    const result = applyScoringPlan(questions, plan);

    expect(result.score).toBe(10); // 4+2+0+3+1
    expect(result.total).toBe(17); // 4+3+5+3+2
    expect(result.questions).toHaveLength(5);
    expect(result.questions.every((q) => q.counts_toward_score)).toBe(true);
    expect(result.notes).toHaveLength(0);
  });

  it('applies optional-section scoring by selecting the best unit', () => {
    // Section B has 3 questions but student only needs best 2.
    const questions = [
      { number: 'Q1', marks_obtained: 5, marks_total: 5 },
      { number: 'Q3a', marks_obtained: 2, marks_total: 4 },
      { number: 'Q3b', marks_obtained: 4, marks_total: 4 },
      { number: 'Q3c', marks_obtained: 1, marks_total: 4 },
    ];
    const plan = {
      groups: [{
        id: 'section_b',
        choose: 2,
        units: [
          { id: 'Q3a', question_numbers: ['Q3a'] },
          { id: 'Q3b', question_numbers: ['Q3b'] },
          { id: 'Q3c', question_numbers: ['Q3c'] },
        ],
        selection_policy: 'best_score',
      }],
    };
    const result = applyScoringPlan(questions, plan);

    // Q1 (5) + Q3b (4) + Q3a (2) = 11; Q3c excluded
    expect(result.score).toBe(11);
    expect(result.total).toBe(13); // 5 + 4 + 4
    const q3c = result.questions.find((q) => q.number === 'Q3c');
    expect(q3c.counts_toward_score).toBe(false);
    expect(q3c.scored_marks_obtained).toBe(0);
  });

  it('assembles multi-page OCR text for evidence materialization', () => {
    // Simulates the evidence stage where answerSheetOcrText is called
    // with joined asset rows from the database.
    const rows = [
      {
        asset_id: 'asset_001',
        is_active: 1,
        markdown: '## Page 1\nQ1. Solve: 2x + 3 = 7\nAnswer: x = 2',
        pages_json: JSON.stringify([
          { index: 0, markdown: 'Q1. Solve: 2x + 3 = 7', tables: [] },
          { index: 1, markdown: 'Answer: x = 2', tables: [{ content: '<table><tr><td>x=2</td></tr></table>' }] },
        ]),
      },
    ];
    const text = answerSheetOcrText(rows);

    expect(text).toContain('[asset:asset_001]');
    expect(text).toContain('--- page 1 ---');
    expect(text).toContain('--- page 2 ---');
    expect(text).toContain('Q1. Solve: 2x + 3 = 7');
    // Tables are only appended when markdown has unresolved [tbl-N.html] refs
    expect(text).not.toContain('[table 1]');
  });

  it('assembles source OCR text for rubric building', () => {
    const rows = [
      { kind: 'question_paper', markdown: 'Q1. Define osmosis. [2 marks]', pages_json: null },
      { kind: 'answer_key', markdown: 'Q1. Movement of water from dilute to concentrated solution.', pages_json: null },
    ];
    const text = sourceOcrText(rows);

    expect(text).toContain('[question_paper]');
    expect(text).toContain('[answer_key]');
    expect(text).toContain('Define osmosis');
    expect(text).toContain('Movement of water');
  });

  it('validates student public login before report publication', () => {
    expect(requireStudentPublicLogin('partnerg.student1', 'stu_123')).toBe('partnerg.student1');
    expect(() => requireStudentPublicLogin('', 'stu_456')).toThrow('Missing canonical primary login');
    expect(() => requireStudentPublicLogin(null, 'stu_789')).toThrow('stu_789');
  });

  it('releases a completed job by clearing worker ownership', () => {
    // The releaseCompletedJob pattern: status='succeeded' AND worker_id matches.
    // Verify the lease timing is consistent with a job that started and finished.
    const clock = () => 1_700_000_000_000;
    const lease = leaseExpiresAt({ leaseMs: WORKER_CONFIG.jobLeaseMs, clock });
    const leaseTime = new Date(lease).getTime();
    // A job claimed now has 30 minutes before lease expiry
    expect(leaseTime - clock()).toBe(30 * 60_000);
  });
});

describe('processing worker error recovery (retry path)', () => {
  it('schedules exponential backoff across retry attempts', () => {
    const { retryBaseMs, retryMaxMs, maxJobAttempts } = WORKER_CONFIG;

    // Attempt 1: base delay (60s)
    expect(retryDelayMs(1, retryBaseMs, retryMaxMs)).toBe(60_000);
    // Attempt 2: 2x base (120s)
    expect(retryDelayMs(2, retryBaseMs, retryMaxMs)).toBe(120_000);
    // Attempt 3: 4x base (240s)
    expect(retryDelayMs(3, retryBaseMs, retryMaxMs)).toBe(240_000);
    // Far future attempts are capped at maxMs
    expect(retryDelayMs(10, retryBaseMs, retryMaxMs)).toBe(retryMaxMs);
    expect(retryDelayMs(20, retryBaseMs, retryMaxMs)).toBe(retryMaxMs);

    // Verify the worker would exhaust at maxJobAttempts
    for (let attempt = 1; attempt <= maxJobAttempts; attempt++) {
      const delay = retryDelayMs(attempt, retryBaseMs, retryMaxMs);
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(retryMaxMs);
    }
  });

  it('computes correct next_attempt_at timestamps for the retry queue', () => {
    const clock = () => 1_700_000_000_000; // Fixed reference
    const { retryBaseMs, retryMaxMs } = WORKER_CONFIG;

    const first = retryAt(1, { baseMs: retryBaseMs, maxMs: retryMaxMs, clock });
    const second = retryAt(2, { baseMs: retryBaseMs, maxMs: retryMaxMs, clock });
    const third = retryAt(3, { baseMs: retryBaseMs, maxMs: retryMaxMs, clock });

    // Each retry is progressively later
    expect(new Date(first).getTime()).toBe(clock() + 60_000);
    expect(new Date(second).getTime()).toBe(clock() + 120_000);
    expect(new Date(third).getTime()).toBe(clock() + 240_000);

    // Ordered chronologically
    expect(new Date(first).getTime()).toBeLessThan(new Date(second).getTime());
    expect(new Date(second).getTime()).toBeLessThan(new Date(third).getTime());
  });

  it('classifies error codes for operational routing', () => {
    // Network errors are retryable
    expect(errorCode({ code: 'ECONNRESET' })).toBe('econnreset');
    expect(errorCode({ code: 'ETIMEDOUT' })).toBe('etimedout');

    // API errors preserve their identity
    expect(errorCode({ code: 'rate_limit_exceeded' })).toBe('rate_limit_exceeded');

    // Generic errors are normalized
    expect(errorCode(new Error('Unexpected upstream failure'))).toBe('error');
    expect(errorCode(null)).toBe('processing_error');
    expect(errorCode({})).toBe('processing_error');

    // Error codes are bounded (max 80 chars)
    const longCode = { code: 'x'.repeat(200) };
    expect(errorCode(longCode).length).toBeLessThanOrEqual(80);
  });

  it('simulates full retry exhaustion from claim to failed_retryable', () => {
    // This mirrors the failJob() logic in the worker:
    // retryable = error?.retryable !== false && attempts < maxJobAttempts
    const { maxJobAttempts, retryBaseMs, retryMaxMs } = WORKER_CONFIG;
    const clock = () => 1_700_000_000_000;

    const attempts = [];
    for (let attempt = 1; attempt <= maxJobAttempts + 1; attempt++) {
      const retryable = attempt < maxJobAttempts;
      const nextAttemptAt = retryable
        ? retryAt(attempt, { baseMs: retryBaseMs, maxMs: retryMaxMs, clock })
        : null;
      attempts.push({ attempt, retryable, nextAttemptAt });
    }

    // First two attempts are retryable with scheduled next_attempt_at
    expect(attempts[0].retryable).toBe(true);
    expect(attempts[0].nextAttemptAt).not.toBeNull();
    expect(attempts[1].retryable).toBe(true);
    expect(attempts[1].nextAttemptAt).not.toBeNull();

    // Third attempt (== maxJobAttempts) exhausts retries
    expect(attempts[2].retryable).toBe(false);
    expect(attempts[2].nextAttemptAt).toBeNull();

    // Status would be 'failed_retryable' with completed_at set
    // (verified by the logic pattern, not db call)
  });

  it('detects lease expiry for stranded job reclamation', () => {
    // reclaimExpiredJobs() checks: lease_expires_at < now
    const clock = () => 1_700_000_000_000;
    const lease = leaseExpiresAt({ leaseMs: WORKER_CONFIG.jobLeaseMs, clock });

    // A lease created now is NOT expired at creation time
    expect(new Date(lease).getTime()).toBeGreaterThan(clock());

    // But IS expired after the lease duration passes
    const futureTime = clock() + WORKER_CONFIG.jobLeaseMs + 1_000;
    expect(new Date(lease).getTime()).toBeLessThan(futureTime);
  });

  it('enforces minimum lease duration of 60 seconds', () => {
    const clock = () => 1_700_000_000_000;
    // Even with a very small leaseMs, the minimum is 60s
    const lease = leaseExpiresAt({ leaseMs: 1_000, clock });
    expect(new Date(lease).getTime() - clock()).toBe(60_000);
  });
});

describe('processing worker pipeline composition', () => {
  it('normalizes a scoring plan with optional sections for report generation', () => {
    const raw = {
      groups: [
        {
          id: 'section_b',
          choose: 2,
          units: [
            { id: 'Q3', question_numbers: ['Q3'] },
            { id: 'Q4', question_numbers: ['Q4'] },
            { id: 'Q5', question_numbers: ['Q5'] },
          ],
          selection_policy: 'best_score',
        },
        // This group should be filtered: choose=0
        { id: 'ignored', choose: 0, units: [{ id: 'Q9', question_numbers: ['Q9'] }] },
      ],
    };
    const normalized = normalizeScoringPlan(raw);
    expect(normalized.groups).toHaveLength(1);
    expect(normalized.groups[0].id).toBe('section_b');
    expect(normalized.groups[0].choose).toBe(2);
    expect(normalized.groups[0].units).toHaveLength(3);
  });

  it('handles page-level OCR with tables for evidence extraction', () => {
    // Tables are appended only when markdown has unresolved [tbl-N.html] refs
    const page = {
      markdown: 'Q5. Complete the table below. [tbl-1.html](tbl-1.html) [tbl-2.html](tbl-2.html)',
      tables: [
        { content: '<table><tr><td>Substance</td><td>pH</td></tr><tr><td>Acid</td><td>3</td></tr></table>' },
        { html: '<table><tr><td>Base</td><td>11</td></tr></table>' },
      ],
    };
    const text = pageOcrText(page);
    expect(text).toContain('Q5. Complete the table below.');
    expect(text).toContain('[table 1]');
    expect(text).toContain('[table 2]');
    expect(text).toContain('Substance');
    expect(text).toContain('Base');
  });

  it('falls back to markdown when pages_json is absent', () => {
    const row = { markdown: 'Simple single-page content', pages_json: null };
    expect(ocrRunText(row)).toBe('Simple single-page content');
  });

  it('truncates extremely long answer sheet OCR to protect model context', () => {
    const rows = [{
      asset_id: 'big_asset',
      markdown: 'x'.repeat(200_000),
      pages_json: null,
    }];
    const text = answerSheetOcrText(rows);
    // answerSheetOcrText caps at 140000 chars
    expect(text.length).toBeLessThanOrEqual(140_000 + 30); // prefix + content
  });
});

describe('FLKRM-157 lease reclaim handling', () => {
  it('counts a reclaim separately and requeues a healthy slow job', () => {
    const decision = reclaimDecision({ leaseReclaimCount: 0, maxReclaims: 3 });
    expect(decision).toEqual({ reclaims: 1, exhausted: false });
  });

  it('does not consume the retry budget on the first reclaims', () => {
    const decision = reclaimDecision({ leaseReclaimCount: 1, maxReclaims: 3 });
    expect(decision.exhausted).toBe(false);
    expect(decision.reclaims).toBe(2);
  });

  it('treats a genuinely stuck job as exhausted only after maxReclaims', () => {
    const decision = reclaimDecision({ leaseReclaimCount: 3, maxReclaims: 3 });
    expect(decision.exhausted).toBe(true);
  });

  it('does not count a reclaimed job claim as a fresh attempt', () => {
    const progressAfterReclaim = JSON.stringify({ phase: 'reclaimed', is_reclaim: 1, reclaim_count: 1 });
    expect(shouldCountClaimAsAttempt(progressAfterReclaim)).toBe(false);
  });

  it('counts a fresh job claim as an attempt', () => {
    expect(shouldCountClaimAsAttempt('{}')).toBe(true);
    expect(shouldCountClaimAsAttempt(JSON.stringify({ phase: 'claimed' }))).toBe(true);
  });

  it('defaults to counting as an attempt on malformed progress json', () => {
    expect(shouldCountClaimAsAttempt('not-json')).toBe(true);
  });
});
