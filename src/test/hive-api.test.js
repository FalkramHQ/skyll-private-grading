import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStudentContext } from '../../api/_lib/contextBuilder.js';
import { resetRateLimitBuckets } from '../../api/_lib/aiRateLimit.js';

function mockDb(handlers) {
  return {
    execute: vi.fn(async (arg) => {
      const sql = String(arg?.sql || arg || '');
      for (const [needle, result] of handlers) {
        if (sql.includes(needle)) return result;
      }
      return { rows: [] };
    }),
  };
}

describe('hive context + API plumbing', () => {
  afterEach(() => {
    resetRateLimitBuckets();
    vi.restoreAllMocks();
  });

  it('loads school-scoped DNA, signals, and synthesis runs', async () => {
    const db = mockDb([
      ['FROM user_credentials uc', {
        rows: [{
          student_id: 'st_1',
          display_name: 'Aarav',
          school: 'Demo School',
          username: 'aa12bb',
          class_name: '10',
        }],
      }],
      ['FROM learner_dna_v2', {
        rows: [{
          dna_json: JSON.stringify({
            schema_version: 2,
            primary_mode: { mode_id: 'maker', description: 'finishes work', evidence: 'Q3' },
            growth_edge: { mode_id: 'calibrator', action: 'check units', evidence: 'Q5' },
            dimensions: [],
            next_move: { title: 'Practice', action: 'Redo Q5' },
          }),
          exam_count: 2,
          question_count: 4,
          updated_at: '2026-08-01T00:00:00.000Z',
        }],
      }],
      ['FROM evidence_signals', {
        rows: [{
          id: 'sig_1',
          submission_id: 'sub_1',
          submission_question_id: 'sq_1',
          exam_id: 'exam_1',
          question_number: '3',
          topic: 'Optics',
          marks_obtained: 2,
          marks_total: 3,
          concept_tags_json: '["lens"]',
          misconception: null,
          strength: 'names the law',
          method_note: null,
          next_practice: 'diagram practice',
          confidence: 0.8,
          evidence_refs_json: '[]',
          extracted_at: '2026-08-01T01:00:00.000Z',
        }],
      }],
      ['FROM report_versions', {
        rows: [{
          id: 'rv_1',
          username: 'aa12bb',
          school: 'Demo School',
          submission_id: 'sub_1',
          student_id: 'st_1',
          published_at: '2026-08-01T00:00:00.000Z',
          payload_json: JSON.stringify({ exams: [{ id: 'exam_1', name: 'Unit Test' }], term1: { subjects: [{ name: 'Physics' }] } }),
        }],
      }],
      ['FROM dna_synthesis_runs', {
        rows: [{
          id: 'run_1',
          status: 'succeeded',
          trigger_source: 'nightly',
          input_signal_ids_json: '["sig_1"]',
          diff_json: JSON.stringify({ primary_mode_changed: false, growth_edge_changed: true }),
          model: 'deepseek-chat',
          synthesizer_version: 'hive-synth-1',
          error: null,
          started_at: '2026-08-01T02:00:00.000Z',
          completed_at: '2026-08-01T02:01:00.000Z',
        }],
      }],
    ]);

    const context = await buildStudentContext(db, {
      schoolId: 'school_1',
      username: 'aa12bb',
    });

    expect(context.studentId).toBe('st_1');
    expect(context.name).toBe('Aarav');
    expect(context.dna.primary_mode.mode_id).toBe('maker');
    expect(context.signals).toHaveLength(1);
    expect(context.signals[0].topic).toBe('Optics');
    expect(context.synthesisRuns[0].diff.growth_edge_changed).toBe(true);
    expect(context.recentReports[0].examName).toBe('Unit Test');
  });

  it('requires schoolId for student context', async () => {
    await expect(buildStudentContext({}, {})).rejects.toThrow(/schoolId/);
  });

  it('resolves nested AI route keys for hive synthesize', async () => {
    const mod = await import('../../api/ai/[...route].js');
    const req = {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' },
      query: { route: ['hive', 'synthesize'] },
      url: '/api/ai/hive-synthesize',
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      end() { return this; },
    };
    // CORS preflight short-circuits before auth.
    await mod.default(req, res);
    expect([200, 204]).toContain(res.statusCode);
  });

  it('handles missing DNA records and malformed JSON payloads gracefully without failing context building', async () => {
    const db = mockDb([
      ['FROM user_credentials uc', {
        rows: [{ student_id: 'st_2', display_name: 'Bhavna', school: 'Demo School', username: 'bb22cc', class_name: '12' }],
      }],
      ['FROM learner_dna_v2', { rows: [] }], // Empty DNA
      ['FROM report_versions', { rows: [{ payload_json: '{bad_json:true}' }] }], // Malformed report json
    ]);
    const context = await buildStudentContext(db, { schoolId: 'school_1', username: 'bb22cc' });
    expect(context.studentId).toBe('st_2');
    expect(context.dna).toBeNull();
    expect(context.recentReports[0]).toMatchObject({ examId: null, examName: null, subject: null });
  });
});


