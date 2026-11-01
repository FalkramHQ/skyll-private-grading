import { describe, expect, it, vi } from 'vitest';
import {
  buildSynthesisPrompt,
  diffDna,
  listStudentsNeedingSynthesis,
  normalizeSynthesizedDna,
  runHiveSynthesis,
} from '../../apps/processing-worker/hiveSynthesis.js';

describe('hive DNA synthesis', () => {
  it('requires evidence ids and preserves mode allowlist', () => {
    const dna = normalizeSynthesizedDna({
      primary_mode: { mode_id: 'wizard', description: 'bad', evidence: 'e', evidence_ids: [] },
      growth_edge: { mode_id: 'calibrator', action: 'practice', evidence: 'gap', evidence_ids: ['esig_1'] },
      dimensions: [{ id: 'maker', state: 'developing', score: 55, evidence_question_ids: ['Q2'] }],
      next_move: { title: 'Next', action: 'Do Q2 again', evidence_ids: ['esig_1'] },
    }, { priorDna: { primary_mode: { mode_id: 'pathfinder', description: 'prior', evidence: 'old' } }, signalIds: ['esig_1', 'esig_2'] });

    expect(dna.schema_version).toBe(2);
    expect(dna.primary_mode.mode_id).toBe('pathfinder');
    expect(dna.growth_edge.mode_id).toBe('calibrator');
    expect(dna.primary_mode.evidence_ids).toEqual(['esig_1', 'esig_2']);
    expect(dna.dimensions.some((row) => row.id === 'architect')).toBe(true);
    expect(dna.assessment_scope.level).toBe('hive_synthesis');
  });

  it('builds an additive synthesis prompt with signal ids', () => {
    const prompt = buildSynthesisPrompt({
      priorDna: { primary_mode: { mode_id: 'maker' } },
      signals: [{ id: 'esig_1', questionNumber: 'Q3', misconception: 'sign error' }],
      reportsSummary: { examCount: 2 },
    });
    expect(prompt).toContain('evidence IDs');
    expect(prompt).toContain('esig_1');
    expect(prompt).toContain('maker');
  });

  it('diffs primary mode and next move changes', () => {
    expect(diffDna(
      { primary_mode: { mode_id: 'maker' }, growth_edge: { mode_id: 'calibrator' }, next_move: { action: 'A' } },
      { primary_mode: { mode_id: 'pathfinder' }, growth_edge: { mode_id: 'calibrator' }, next_move: { action: 'B' } },
    )).toEqual(expect.objectContaining({
      primary_mode_changed: true,
      growth_edge_changed: false,
      next_move_changed: true,
    }));
  });

  it('runs synthesis with injected model and upserts DNA + run history', async () => {
    const execute = vi.fn(async ({ sql }) => {
      if (sql.includes('FROM evidence_signals')) {
        return {
          rows: [{
            id: 'esig_1',
            submission_id: 'sub_1',
            submission_question_id: 'sq_1',
            exam_id: 'exam_1',
            question_number: 'Q2',
            topic: 'Optics',
            marks_obtained: 2,
            marks_total: 4,
            concept_tags_json: '["refraction"]',
            misconception: 'diagram missing',
            strength: 'concept ok',
            method_note: null,
            next_practice: 'draw ray diagram',
            confidence: 0.7,
            evidence_refs_json: '["Q2"]',
            extracted_at: '2026-08-04T00:00:00.000Z',
          }],
        };
      }
      if (sql.includes('FROM learner_dna_v2')) return { rows: [{ dna_json: JSON.stringify({ primary_mode: { mode_id: 'maker', description: 'prior', evidence: 'old' }, growth_edge: { mode_id: 'calibrator', action: 'check', evidence: 'old' }, dimensions: [], next_move: { title: 't', action: 'a' } }) }] };
      if (sql.includes('FROM report_versions')) return { rows: [] };
      if (sql.includes('FROM student_user_links')) return { rows: [{ login_id: 'ab12cd' }] };
      if (sql.includes('FROM learner_dna WHERE username')) return { rows: [{ school: 'Demo', student_name: 'Aarav', class_name: '10' }] };
      return { rows: [] };
    });
    const db = { execute };

    const result = await runHiveSynthesis(db, {
      schoolId: 'school_1',
      studentId: 'student_1',
      triggerSource: 'manual',
      callModel: async () => ({
        model: 'flash',
        result: {
          primary_mode: { mode_id: 'pathfinder', description: 'Reads questions carefully', evidence: 'Q2', evidence_ids: ['esig_1'] },
          growth_edge: { mode_id: 'cartographer', action: 'Draw diagrams', evidence: 'diagram missing', evidence_ids: ['esig_1'] },
          dimensions: [{ id: 'pathfinder', state: 'developing', score: 60, evidence_question_ids: ['Q2'] }],
          next_move: { title: 'Diagram drill', action: 'Redraw Q2', evidence_ids: ['esig_1'] },
        },
      }),
    });

    expect(result.skipped).toBe(false);
    expect(result.signalCount).toBe(1);
    expect(result.dna.primary_mode.mode_id).toBe('pathfinder');
    expect(result.diff.primary_mode_changed).toBe(true);
    expect(execute.mock.calls.some(([arg]) => String(arg.sql || arg).includes('INSERT INTO learner_dna_v2'))).toBe(true);
    expect(execute.mock.calls.some(([arg]) => String(arg.sql || arg).includes('INSERT INTO dna_synthesis_runs'))).toBe(true);
  });
});

describe('hive synthesis failure handling', () => {
  const signalRow = {
    id: 'esig_1', submission_id: 'sub_1', submission_question_id: 'sq_1', exam_id: 'exam_1',
    question_number: 'Q2', topic: 'Optics', marks_obtained: 2, marks_total: 4,
    concept_tags_json: '["refraction"]', misconception: null, strength: null, method_note: null,
    next_practice: null, confidence: 0.7, evidence_refs_json: '["Q2"]', extracted_at: '2026-08-04T00:00:00.000Z',
  };

  it('records a failed run and rethrows when the model call fails', async () => {
    const execute = vi.fn(async ({ sql }) => {
      if (sql.includes('FROM evidence_signals')) return { rows: [signalRow] };
      if (sql.includes('FROM learner_dna_v2')) return { rows: [{ dna_json: JSON.stringify({ primary_mode: { mode_id: 'maker' }, dimensions: [] }) }] };
      return { rows: [] };
    });

    await expect(runHiveSynthesis({ execute }, {
      schoolId: 'school_1',
      studentId: 'student_1',
      triggerSource: 'nightly',
      callModel: async () => { throw new Error('Unterminated string in JSON at position 6749'); },
    })).rejects.toThrow(/Unterminated string/);

    const failedInsert = execute.mock.calls.find(([arg]) => String(arg.sql).includes('INSERT INTO dna_synthesis_runs') && String(arg.sql).includes("'failed'"));
    expect(failedInsert).toBeTruthy();
    expect(failedInsert[0].args).toContain('Unterminated string in JSON at position 6749');
    expect(execute.mock.calls.some(([arg]) => String(arg.sql).includes('INSERT INTO learner_dna_v2'))).toBe(false);
  });

  it('skips students whose last synthesis attempt failed inside the cooldown window', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const now = Date.parse('2026-10-06T18:00:00.000Z');
    await listStudentsNeedingSynthesis({ execute }, { schoolId: 'school_1', limit: 10, now });

    const [{ sql, args }] = execute.mock.calls[0];
    expect(sql).toContain("fr.status = 'failed'");
    expect(sql).toContain('NOT EXISTS');
    expect(args[0]).toBe('school_1');
    // cutoff is `now - cooldown`, i.e. strictly before now
    expect(Date.parse(args[1])).toBeLessThan(now);
    expect(Date.parse(args[1])).toBeGreaterThanOrEqual(now - 7 * 24 * 60 * 60 * 1000);
    expect(args[2]).toBe(10);
  });
});
