import { describe, expect, it, vi } from 'vitest';
import {
  generatePracticeTest,
  gradePracticeSubmission,
  listPracticeTests,
  normalizeGeneratedQuestions,
  practiceResultsForDnaFeed,
} from '../../api/_lib/practice.js';
import { InsufficientEvidenceError } from '../../api/_lib/contextBuilder.js';

describe('practice tests', () => {
  it('normalizes generated question payloads', () => {
    const rows = normalizeGeneratedQuestions({
      questions: [
        { topic: 'Circles', question_text: 'Prove…', answer_key: '…', max_marks: 3, difficulty: 'hard' },
      ],
    }, { subject: 'Mathematics', topics: ['Circles'], count: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0].questionText).toBe('Prove…');
    expect(rows[0].maxMarks).toBe(3);
  });

  it('refuses to generate when evidence is insufficient', async () => {
    const db = { execute: async () => ({ rows: [] }) };
    await expect(generatePracticeTest(db, { schoolId: 'sch_x', username: 's1' }))
      .rejects.toThrow(InsufficientEvidenceError);
  });

  it('allows explicit-topic generation when the bank can serve it', async () => {
    const bankDb = {
      execute: async ({ sql }) => {
        if (sql.includes('question_bank')) {
          return {
            rows: [{
              id: 'qb1', topic: 'Circles', difficulty: 'medium', question_type: 'subjective',
              question_text: 'State the tangent property', answer_key: 'Tangent ⊥ radius',
              rubric_json: '{}', max_marks: 2, status: 'active',
            }],
          };
        }
        return { rows: [] };
      },
    };
    const test = await generatePracticeTest(bankDb, {
      schoolId: 'sch_x',
      username: 's1',
      topics: ['Circles'],
      count: 1,
      callModel: async () => ({ model: null, result: { questions: [] } }),
    });
    expect(test.questions.length).toBeGreaterThan(0);
    expect(test.questions[0].bankId).toBe('qb1');
  });

  it('lists practice tests scoped by school and username with latest score', async () => {
    const db = {
      execute: async ({ sql, args }) => {
        if (sql.includes('FROM practice_tests')) {
          expect(sql).toContain('school_id = ?');
          expect(sql).toContain('username = ?');
          expect(args).toEqual(['school_1', 'aa12', 20]);
          return {
            rows: [{
              id: 'pt_1', username: 'aa12', subject: 'Mathematics',
              topic_focus_json: '["Circles"]', total_marks: 10,
              status: 'graded', created_at: '2026-08-04T00:00:00.000Z',
            }],
          };
        }
        if (sql.includes('FROM practice_submissions')) {
          return { rows: [{ practice_test_id: 'pt_1', score: 7 }] };
        }
        return { rows: [] };
      },
    };
    const rows = await listPracticeTests(db, { schoolId: 'school_1', username: 'aa12' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'pt_1', subject: 'Mathematics', status: 'graded', score: 7, totalMarks: 10 });
    expect(rows[0].topicFocus).toEqual(['Circles']);
  });

  it('summarizes topic outcomes and reports feed status', () => {
    const feed = practiceResultsForDnaFeed({
      practiceTest: {
        id: 'pt_1',
        questions: [
          { id: 'pq_1', topic: 'Circles', maxMarks: 2 },
          { id: 'pq_2', topic: 'Circles', maxMarks: 2 },
        ],
      },
      submission: {
        id: 'ps_1',
        feedback: {
          questions: [
            { questionId: 'pq_1', marksObtained: 2, maxMarks: 2 },
            { questionId: 'pq_2', marksObtained: 1, maxMarks: 2 },
          ],
        },
      },
      feedsDna: true,
      written: 2,
    });
    expect(feed.feedsDna).toBe(true);
    expect(feed.written).toBe(2);
    expect(feed.topicOutcomes[0]).toEqual({ topic: 'Circles', pct: 75, questions: 2 });
  });

  it('generates and grades a practice test with injectable model', async () => {
    const rows = [];
    const execute = vi.fn(async (arg) => {
      const sql = String(arg.sql || '');
      if (sql.includes('student_user_links') && sql.includes('user_credentials')) {
        return {
          rows: [{ student_id: 'st_1', display_name: 'AA', school: 'School 1', username: 'aa12', class_name: '9' }],
        };
      }
      if (sql.includes('INSERT INTO practice_tests')) {
        rows.push({ type: 'test', args: arg.args });
        return { rows: [] };
      }
      if (sql.includes('FROM practice_tests')) {
        return {
          rows: [{
            id: 'pt_fixed',
            student_id: 'st_1',
            school_id: 'school_1',
            username: 'aa12',
            subject: 'Mathematics',
            topic_focus_json: '["Circles"]',
            questions_json: JSON.stringify([
              {
                id: 'pq_1',
                topic: 'Circles',
                difficulty: 'easy',
                questionType: 'subjective',
                questionText: 'State the tangent property',
                answerKey: 'Tangent ⊥ radius',
                maxMarks: 2,
                rubric: {},
              },
            ]),
            difficulty_profile_json: '{"easy":1}',
            total_marks: 2,
            status: 'generated',
            generated_by: 'self_request',
            model: null,
            created_at: '2026-08-04T00:00:00.000Z',
            updated_at: '2026-08-04T00:00:00.000Z',
          }],
        };
      }
      if (sql.includes('school_feature_flags') && sql.includes('deep_signals')) {
        return { rows: [{ enabled: 1 }] };
      }
      if (sql.includes('FROM evidence_signals')) {
        return {
          rows: Array.from({ length: 5 }, (_, i) => ({
            id: `esig_${i}`,
            submission_id: `sub_${i}`,
            submission_question_id: `sq_${i}`,
            exam_id: 'exam_1',
            question_number: i + 1,
            topic: 'Circles',
            marks_obtained: 1,
            marks_total: 2,
            concept_tags_json: '[]',
            misconception: null,
            strength: null,
            method_note: null,
            next_practice: null,
            confidence: 0.6,
            evidence_refs_json: '[]',
            extracted_at: '2026-08-04T00:00:00.000Z',
          })),
        };
      }
      if (sql.includes('INSERT INTO evidence_signals')) {
        rows.push({ type: 'signal', sql });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO practice_submissions') || sql.includes('UPDATE practice_tests')) {
        rows.push({ type: 'grade', sql });
        return { rows: [] };
      }
      return { rows: [] };
    });

    const generated = await generatePracticeTest({ execute }, {
      schoolId: 'school_1',
      username: 'aa12',
      subject: 'Mathematics',
      topics: ['Circles'],
      count: 1,
      persistBank: false,
      callModel: async () => ({
        result: {
          questions: [{
            topic: 'Circles',
            difficulty: 'easy',
            question_text: 'State the tangent property',
            answer_key: 'Tangent ⊥ radius',
            max_marks: 2,
          }],
        },
        model: 'deepseek-chat',
      }),
    });
    expect(generated.questions[0].questionText).toMatch(/tangent/i);
    expect(rows.some((row) => row.type === 'test')).toBe(true);

    const graded = await gradePracticeSubmission({ execute }, {
      schoolId: 'school_1',
      practiceTestId: 'pt_fixed',
      answers: [{ questionId: 'pq_1', answer: 'The tangent is perpendicular to the radius.' }],
      callModel: async () => ({
        result: {
          questions: [{
            questionId: 'pq_1',
            marksObtained: 2,
            maxMarks: 2,
            feedback: 'Correct',
            isCorrect: true,
          }],
          overall_feedback: 'Nice work',
        },
        model: 'deepseek-chat',
      }),
    });
    expect(graded.score).toBe(2);
    expect(graded.dnaFeed.feedsDna).toBe(true);
    expect(graded.dnaFeed.written).toBe(1);
    expect(rows.some((row) => row.type === 'grade')).toBe(true);
    expect(rows.some((row) => row.type === 'signal')).toBe(true);
  });
});
