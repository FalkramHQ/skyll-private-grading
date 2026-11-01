import { describe, expect, it, vi } from 'vitest';
import {
  generateBriefing,
  generateInterventions,
  generateLessonPlan,
  generateParentReport,
  generateQuiz,
  runTeacherCopilot,
} from '../../api/_lib/teacherAi.js';
import { InsufficientEvidenceError } from '../../api/_lib/contextBuilder.js';

function mockDb(overrides = {}) {
  return {
    execute: vi.fn(async (arg) => {
      const sql = String(arg.sql || '');
      if (overrides.execute) return overrides.execute(arg, sql);
      if (sql.includes('FROM schools')) return { rows: [{ display_name: 'Partner Academy E' }] };
      if (sql.includes('FROM evidence_signals') && sql.includes('GROUP BY topic')) {
        return {
          rows: [{
            topic: 'Electromagnetic Induction',
            n: 12,
            weak_n: 5,
            samples: 'missed Lenz direction',
          }],
        };
      }
      if (sql.includes('FROM report_versions') && sql.includes('payload_json')) {
        return {
          rows: [{
            payload_json: JSON.stringify({
              exams: [{ name: 'Cycle Test 2' }],
              term1: {
                subjects: [{
                  name: 'Physics',
                  score: 42,
                  max_marks: 70,
                  learning_profile: {
                    core_strength: 'Clear definitions',
                    strategies: [{ topic: 'EMI', strategy: 'Practise Lenz direction with diagrams' }],
                  },
                  recommendations: [{ topic: 'EMI', action: 'Two short Lenz drills this week' }],
                }],
              },
            }),
            published_at: '2026-08-01T00:00:00.000Z',
            username: 'stu1',
          }],
        };
      }
      if (sql.includes('FROM report_versions')) {
        return { rows: [{ reports: 12, students: 8, latest_published: '2026-08-01T00:00:00.000Z' }] };
      }
      if (sql.includes('FROM learner_dna_v2') && sql.includes('dna_json')) {
        return {
          rows: [{
            dna_json: JSON.stringify({
              growth_edge: { mode_id: 'analyst' },
              next_move: { action: 'Retake EMI exit ticket' },
            }),
            exam_count: 2,
            question_count: 20,
            updated_at: '2026-08-01',
          }],
        };
      }
      if (sql.includes('FROM learner_dna_v2')) {
        return { rows: [{ mode_id: 'maker', n: 4 }] };
      }
      if (sql.includes('COUNT(*) AS n FROM evidence_signals')) {
        return { rows: [{ n: 20 }] };
      }
      if (sql.includes('FROM evidence_signals') && !sql.includes('GROUP BY')) {
        return {
          rows: Array.from({ length: 6 }, (_, i) => ({
            id: `sig_${i}`,
            topic: 'EMI',
            misconception: 'Lenz direction flipped',
            marks_obtained: 1,
            marks_total: 3,
            question_number: String(i + 1),
            status: 'active',
          })),
        };
      }
      if (sql.includes('FROM curriculum_standards')) {
        return { rows: [{ id: 'cbse_12_phys_emi', grade: '12th', topic: 'Electromagnetic Induction' }] };
      }
      if (sql.includes('FROM question_bank')) return { rows: [] };
      if (sql.includes('student_enrollments') || sql.includes('FROM students')) {
        return { rows: [{ id: 'stu_1', username: 'stu1', name: 'Aarav Patel', class_name: '12', school: 'Partner Academy E' }] };
      }
      return { rows: [] };
    }),
  };
}

describe('teacher AI', () => {
  it('runs copilot with injectable model', async () => {
    const result = await runTeacherCopilot(mockDb(), {
      schoolId: 'sch_1',
      question: 'What should I reteach?',
      subject: 'Physics',
      callModel: async () => ({
        result: {
          reply: 'Reteach EMI with Lenz emphasis.',
          actions: ['Exit ticket on Lenz'],
          citations: ['topic:Electromagnetic Induction'],
        },
        model: 'test-model',
      }),
    });
    expect(result.reply).toMatch(/EMI|Lenz/i);
    expect(result.actions[0]).toMatch(/Exit ticket/);
    expect(result.model).toBe('test-model');
  });

  it('refuses generation when cohort evidence is thin', async () => {
    const emptyDb = { execute: async () => ({ rows: [] }) };
    await expect(runTeacherCopilot(emptyDb, { schoolId: 'sch_x', question: 'Where is the class weak?' }))
      .rejects.toThrow(InsufficientEvidenceError);
    await expect(generateLessonPlan(emptyDb, { schoolId: 'sch_x' }))
      .rejects.toThrow(InsufficientEvidenceError);
    await expect(generateInterventions(emptyDb, { schoolId: 'sch_x' }))
      .rejects.toThrow(InsufficientEvidenceError);
    await expect(generateBriefing(emptyDb, { schoolId: 'sch_x' }))
      .rejects.toThrow(InsufficientEvidenceError);
  });

  it('throws an honest error when the model fails', async () => {
    const db = mockDb();
    const boom = async () => { throw new Error('llm down'); };
    await expect(generateLessonPlan(db, { schoolId: 'sch_1', subject: 'Physics', callModel: boom }))
      .rejects.toThrow(/model unavailable/);
    await expect(generateBriefing(db, { schoolId: 'sch_1', callModel: boom }))
      .rejects.toThrow(/model unavailable/);
    await expect(generateInterventions(db, { schoolId: 'sch_1', callModel: boom }))
      .rejects.toThrow(/model unavailable/);
    await expect(generateParentReport(db, { schoolId: 'sch_1', username: 'stu1', callModel: boom }))
      .rejects.toThrow(/model unavailable/);
  });

  it('drafts a parent report grounded in published evidence', async () => {
    const draft = await generateParentReport(mockDb(), {
      schoolId: 'sch_1',
      username: 'stu1',
      subject: 'Physics',
      callModel: async () => ({
        result: {
          subject_line: "Update on Aarav's Physics assessment",
          message: 'Dear Parent, Aarav showed clear definitions on Cycle Test 2 (42/70). Please review Lenz direction with two short drills this week.',
          talking_points: ['Score 42/70', 'Strength: clear definitions'],
          suggested_next_steps: ['Two Lenz drills'],
          tone: 'supportive',
        },
        model: 'test-model',
      }),
    });
    expect(draft.review_status).toBe('draft');
    expect(draft.message).toMatch(/Aarav|Lenz|42\/70/i);
    expect(draft.talking_points.length).toBeGreaterThan(0);
    expect(draft.evidence.reports).toBeGreaterThan(0);
  });

  it('allows quiz generation when explicit topics hit the question bank', async () => {
    const bankDb = {
      execute: async ({ sql }) => {
        if (sql.includes('FROM question_bank')) {
          return {
            rows: Array.from({ length: 3 }, (_, i) => ({
              id: `qb${i}`, topic: 'Solutions', difficulty: 'medium', question_type: 'subjective',
              question_text: `Question ${i + 1}`, answer_key: 'A', rubric_json: '{}', max_marks: 2, status: 'active',
            })),
          };
        }
        if (sql.includes('FROM schools')) return { rows: [{ display_name: 'X' }] };
        return { rows: [] };
      },
    };
    const quiz = await generateQuiz(bankDb, {
      schoolId: 'sch_1',
      subject: 'Chemistry',
      topics: ['Solutions'],
      count: 3,
      persistBank: false,
      callModel: async () => ({ model: null, result: { questions: [] } }),
    });
    expect(quiz.questions).toHaveLength(3);
    expect(quiz.questions[0].source).toBe('question_bank');
  });
});
