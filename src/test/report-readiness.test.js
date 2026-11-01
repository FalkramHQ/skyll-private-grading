// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_BLOCKED_FLAG,
  EVIDENCE_BLOCKED_REASON,
  TEACHER_MARKED_REASON,
  REPORT_BLOCKING_QUESTION_STATUSES,
  REPORT_TERMINAL_QUESTION_STATUSES,
  presentQuestionForReport,
  questionBlocksReports,
  reportBlockingCountStatement,
} from '../../apps/processing-worker/reportReadiness.js';
import { applyScoringPlan } from '../../apps/processing-worker/scoringPlan.js';
import { scoreStatus } from '../../apps/processing-worker/workerUtils.js';

describe('report readiness predicate', () => {
  it('blocks reports only while a question is still waiting for evidence or grading', () => {
    for (const status of ['pending', 'evidence_ready', 'grading']) expect(questionBlocksReports(status)).toBe(true);
    expect(questionBlocksReports('Evidence_Ready')).toBe(true);
  });

  it('treats every terminal status as ready, including evidence_blocked and regraded', () => {
    for (const status of REPORT_TERMINAL_QUESTION_STATUSES) expect(questionBlocksReports(status)).toBe(false);
    expect(questionBlocksReports('evidence_blocked')).toBe(false);
    expect(questionBlocksReports('regraded')).toBe(false);
    expect(questionBlocksReports('approved')).toBe(false);
    expect(questionBlocksReports('flagged')).toBe(false);
  });

  it('keeps the blocking and terminal vocabularies disjoint', () => {
    for (const status of REPORT_BLOCKING_QUESTION_STATUSES) expect(REPORT_TERMINAL_QUESTION_STATUSES).not.toContain(status);
  });

  it('builds a count statement scoped to the test and the blocking statuses only', () => {
    const statement = reportBlockingCountStatement('test_1');
    expect(statement.sql).toContain('submission.test_id = ?');
    expect(statement.sql).toMatch(/IN \(\?, \?, \?\)/);
    expect(statement.sql).not.toContain('NOT IN');
    expect(statement.args).toEqual(['test_1', ...REPORT_BLOCKING_QUESTION_STATUSES]);
  });
});

describe('evidence_blocked questions inside a report', () => {
  it('render as not attempted with a visible flag, a reason and zero marks', () => {
    const presented = presentQuestionForReport({ gradeStatus: 'evidence_blocked', marks: null, total: 4, attempted: true, scoreStatus });
    expect(presented).toEqual({
      status: 'not_attempted',
      marks_obtained: 0,
      flagged: true,
      review_flag: EVIDENCE_BLOCKED_FLAG,
      grading_reason: EVIDENCE_BLOCKED_REASON,
      evidence_blocked: true,
    });
  });

  it("show the teacher's mark once a teacher has marked the answer from the sheet", () => {
    expect(presentQuestionForReport({ gradeStatus: 'evidence_blocked', marks: 3, total: 3, scoreStatus, teacherMarks: 3 })).toEqual({
      status: 'correct', marks_obtained: 3, flagged: false, review_flag: null, grading_reason: TEACHER_MARKED_REASON, evidence_blocked: false,
    });
    expect(presentQuestionForReport({ gradeStatus: 'evidence_blocked', marks: 0, total: 3, scoreStatus, teacherMarks: 0 }))
      .toMatchObject({ marks_obtained: 0, evidence_blocked: false, flagged: false });
  });

  it('pass the report guardrail that requires a grading reason on attempted questions', () => {
    const presented = presentQuestionForReport({ gradeStatus: 'evidence_blocked', marks: 0, total: 1, scoreStatus });
    const guardrailFails = !presented.grading_reason && presented.status !== 'not_attempted';
    expect(guardrailFails).toBe(false);
  });

  it('leave graded questions untouched and fall back to the score status when the grade has none', () => {
    expect(presentQuestionForReport({ gradeStatus: 'partial', marks: 2, total: 4, gradingReason: 'Half the steps shown.', scoreStatus }))
      .toMatchObject({ status: 'partial', marks_obtained: 2, flagged: false, review_flag: null, grading_reason: 'Half the steps shown.', evidence_blocked: false });
    expect(presentQuestionForReport({ gradeStatus: '', marks: 3, total: 3, scoreStatus }).status).toBe('correct');
    expect(presentQuestionForReport({ gradeStatus: '', marks: 0, total: 3, attempted: false, scoreStatus }).status).toBe('not_attempted');
  });

  it('contribute zero to the scoring plan total while keeping their allocated marks visible', () => {
    const blocked = presentQuestionForReport({ gradeStatus: 'evidence_blocked', marks: null, total: 2, scoreStatus });
    const questions = [
      { number: 'Q1', marks_obtained: 3, marks_total: 3, status: 'correct' },
      { number: 'Q2', marks_obtained: blocked.marks_obtained, marks_total: 2, status: blocked.status, flagged: blocked.flagged, review_flag: blocked.review_flag },
    ];
    const scoring = applyScoringPlan(questions, { groups: [] });
    expect(scoring.score).toBe(3);
    expect(scoring.total).toBe(5);
    expect(scoring.questions[1]).toMatchObject({ status: 'not_attempted', flagged: true, review_flag: EVIDENCE_BLOCKED_FLAG, counts_toward_score: true, scored_marks_obtained: 0 });
  });
});
