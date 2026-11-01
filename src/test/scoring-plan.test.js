import { describe, expect, it } from 'vitest';
import { applyScoringPlan } from '../../apps/processing-worker/scoringPlan.js';

describe('canonical optional-choice scoring', () => {
  it('keeps compulsory questions and scores the best permitted optional answers', () => {
    const result = applyScoringPlan([
      { number: 'Q1', marks_obtained: 1, marks_total: 1, attempted: true },
      { number: 'Q3', marks_obtained: 2, marks_total: 2, attempted: true },
      { number: 'Q4', marks_obtained: 1, marks_total: 2, attempted: true },
      { number: 'Q5', marks_obtained: 2, marks_total: 2, attempted: true },
    ], { groups: [{ id: 'section_b', choose: 2, question_numbers: ['Q3', 'Q4', 'Q5'] }] });

    expect(result.total).toBe(5);
    expect(result.score).toBe(5);
    expect(result.questions.find((question) => question.number === 'Q4')).toMatchObject({ counts_toward_score: false, scored_marks_allocated: 0 });
  });

  it('does not count unanswered optional questions ahead of attempted work', () => {
    const result = applyScoringPlan([
      { number: 'Q9', marks_obtained: 0, marks_total: 3, attempted: false },
      { number: 'Q10', marks_obtained: 1, marks_total: 3, attempted: true },
      { number: 'Q11', marks_obtained: 0, marks_total: 3, attempted: true },
    ], { groups: [{ id: 'section_c', choose: 2, question_numbers: ['Q9', 'Q10', 'Q11'] }] });

    expect(result.questions.find((question) => question.number === 'Q9').counts_toward_score).toBe(false);
    expect(result.total).toBe(6);
  });

  it('keeps multipart questions together when selecting optional choices', () => {
    const result = applyScoringPlan([
      { number: 'Q3', marks_obtained: 2, marks_total: 2, attempted: true },
      { number: 'Q5(i)', marks_obtained: 1, marks_total: 1, attempted: true },
      { number: 'Q5(ii)', marks_obtained: 1, marks_total: 1, attempted: true },
      { number: 'Q6(i)', marks_obtained: 1, marks_total: 1, attempted: true },
      { number: 'Q6(ii)', marks_obtained: 0, marks_total: 1, attempted: true },
    ], { groups: [{ id: 'section_b', choose: 2, units: [{ id: 'Q3', question_numbers: ['Q3'] }, { id: 'Q5', question_numbers: ['Q5(i)', 'Q5(ii)'] }, { id: 'Q6', question_numbers: ['Q6(i)', 'Q6(ii)'] }] }] });

    expect(result.total).toBe(4);
    expect(result.questions.find((question) => question.number === 'Q6(i)')).toMatchObject({ counts_toward_score: false });
    expect(result.questions.find((question) => question.number === 'Q6(ii)')).toMatchObject({ counts_toward_score: false });
  });

  it('applies attempt_order selection from evidence source_pages, differing from best-score where they disagree', () => {
    const questions = [
      { number: 'Q1', marks_obtained: 3, marks_total: 3, attempted: true, source_pages: [3] },
      { number: 'Q2', marks_obtained: 0, marks_total: 3, attempted: true, source_pages: [1] },
      { number: 'Q3', marks_obtained: 1, marks_total: 3, attempted: true, source_pages: [2] },
    ];
    const plan = { groups: [{ id: 'section_b', choose: 1, question_numbers: ['Q1', 'Q2', 'Q3'], selection_policy: 'attempt_order' }] };

    // Best-score would pick Q1 (highest-scoring); attempt_order must pick Q2 (first attempted page).
    const bestScore = applyScoringPlan(questions, { groups: [{ id: 'section_b', choose: 1, question_numbers: ['Q1', 'Q2', 'Q3'] }] });
    const byOrder = applyScoringPlan(questions, plan);

    expect(bestScore.questions.find((q) => q.number === 'Q2').counts_toward_score).toBe(false);
    expect(byOrder.questions.find((q) => q.number === 'Q2').counts_toward_score).toBe(true);
    expect(byOrder.questions.find((q) => q.number === 'Q1').counts_toward_score).toBe(false);
    expect(byOrder.questions.find((q) => q.number === 'Q3').counts_toward_score).toBe(false);
  });

  it('prefers the earlier page of a multi-page source when deriving attempt order', () => {
    const questions = [
      { number: 'Q1', marks_obtained: 3, marks_total: 3, attempted: true, source_pages: [2, 3] },
      { number: 'Q2', marks_obtained: 2, marks_total: 3, attempted: true, source_pages: [1, 4] },
    ];
    const plan = { groups: [{ id: 'section_b', choose: 1, question_numbers: ['Q1', 'Q2'], selection_policy: 'attempt_order' }] };

    const result = applyScoringPlan(questions, plan);
    expect(result.questions.find((q) => q.number === 'Q2').counts_toward_score).toBe(true);
    expect(result.questions.find((q) => q.number === 'Q1').counts_toward_score).toBe(false);
  });

  it('falls back to best-score when attempt order cannot be established', () => {
    const questions = [
      { number: 'Q1', marks_obtained: 3, marks_total: 3, attempted: true, source_pages: [] },
      { number: 'Q2', marks_obtained: 1, marks_total: 3, attempted: true, source_pages: [] },
    ];
    const plan = { groups: [{ id: 'section_b', choose: 1, question_numbers: ['Q1', 'Q2'], selection_policy: 'attempt_order' }] };

    const result = applyScoringPlan(questions, plan);
    expect(result.questions.find((q) => q.number === 'Q1').counts_toward_score).toBe(true);
    expect(result.questions.find((q) => q.number === 'Q2').counts_toward_score).toBe(false);
  });

  it('records the applied selection policy per group', () => {
    const questions = [
      { number: 'Q1', marks_obtained: 3, marks_total: 3, attempted: true, source_pages: [2] },
      { number: 'Q2', marks_obtained: 0, marks_total: 3, attempted: true, source_pages: [1] },
    ];
    const plan = { groups: [{ id: 'section_b', choose: 1, question_numbers: ['Q1', 'Q2'], selection_policy: 'attempt_order' }] };

    const result = applyScoringPlan(questions, plan);
    expect(result.notes[0]).toMatchObject({ id: 'section_b', selection_policy: 'attempt_order' });
  });

  it('matches scoring-plan ids that use underscores to live paren question numbers', () => {
    const result = applyScoringPlan([
      { number: 'Q1A(i)', marks_obtained: 1, marks_total: 1, attempted: true },
      { number: 'Q1A(ii)', marks_obtained: 0.5, marks_total: 1, attempted: true },
      { number: 'Q1B(i)', marks_obtained: 0, marks_total: 2, attempted: true },
      { number: 'Q1B(ii)', marks_obtained: 1.5, marks_total: 2, attempted: true },
      { number: 'Q1B(iii)', marks_obtained: 0, marks_total: 2, attempted: true },
      { number: 'Q5A', marks_obtained: 0, marks_total: 5, attempted: true },
      { number: 'Q5B', marks_obtained: 0, marks_total: 5, attempted: false },
    ], {
      groups: [
        { id: 'section_q1a', choose: 1, units: [{ id: 'Q1A_i', question_numbers: ['Q1A_i'] }, { id: 'Q1A_ii', question_numbers: ['Q1A_ii'] }] },
        { id: 'section_q1b', choose: 2, units: [{ id: 'Q1B_i', question_numbers: ['Q1B_i'] }, { id: 'Q1B_ii', question_numbers: ['Q1B_ii'] }, { id: 'Q1B_iii', question_numbers: ['Q1B_iii'] }] },
        { id: 'section_q5', choose: 1, units: [{ id: 'Q5A', question_numbers: ['Q5A'] }, { id: 'Q5B', question_numbers: ['Q5B'] }] },
      ],
    });

    expect(result.total).toBe(1 + 4 + 5);
    expect(result.questions.find((question) => question.number === 'Q1A(ii)').counts_toward_score).toBe(false);
    expect(result.questions.find((question) => question.number === 'Q1B(iii)').counts_toward_score).toBe(false);
    expect(result.questions.find((question) => question.number === 'Q5B').counts_toward_score).toBe(false);
  });
});
