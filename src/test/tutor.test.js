import { describe, expect, it, vi } from 'vitest';
import {
  buildTutorSystemPrompt,
  buildTutorUserPrompt,
  normalizeTutorResult,
  runTutorTurn,
} from '../../api/_lib/tutor.js';

describe('skyll tutor', () => {
  it('builds an evidence-bound system prompt with mode hint', () => {
    const prompt = buildTutorSystemPrompt({ learningMode: 'maker' });
    expect(prompt).toMatch(/Never invent/);
    expect(prompt).toMatch(/Maker/i);
    expect(prompt).toMatch(/citations/);
  });

  it('includes DNA, signals, and history in the user prompt', () => {
    const prompt = buildTutorUserPrompt({
      question: 'What should I revise in trig?',
      context: {
        name: 'Aarav',
        className: '10th',
        board: 'ICSE',
        school: 'Demo',
        dna: {
          primary_mode: { mode_id: 'maker' },
          growth_edge: { mode_id: 'calibrator', action: 'check units' },
          topic_mastery: [{ topic: 'Trigonometric Identities', pct: 40 }],
        },
        signals: [{
          id: 'sig_1',
          questionNumber: '3',
          topic: 'Trigonometric Identities',
          misconception: 'confused identity',
          strength: null,
          marksObtained: 1,
          marksTotal: 3,
        }],
        recentReports: [{ examName: 'Unit Test', subject: 'Mathematics' }],
        curriculum: [{ topic: 'Trigonometric Identities' }],
      },
      history: [{ message_role: 'user', content: 'hi' }],
    });
    expect(prompt).toContain('What should I revise in trig?');
    expect(prompt).toContain('Trigonometric Identities');
    expect(prompt).toContain('sig_1');
  });

  it('normalizes assistant JSON payloads', () => {
    expect(normalizeTutorResult({
      reply: 'Focus on identities',
      citations: ['Q3'],
      suggested_next: 'Try a prove question',
    })).toEqual({
      reply: 'Focus on identities',
      citations: ['Q3'],
      suggestedNext: 'Try a prove question',
    });
  });

  it('runs a tutor turn with injectable model and stores both messages', async () => {
    const execute = vi.fn(async (arg) => {
      const sql = String(arg.sql || '');
      if (sql.includes('FROM student_user_links') || sql.includes('FROM user_credentials')) {
        return { rows: [{ student_id: 'st_1', display_name: 'Aarav', school: 'Demo', username: 'aa12', class_name: '10th' }] };
      }
      if (sql.includes('FROM learner_dna')) return { rows: [] };
      if (sql.includes('FROM evidence_signals')) return { rows: [] };
      if (sql.includes('FROM report_versions')) return { rows: [] };
      if (sql.includes('FROM dna_synthesis_runs')) return { rows: [] };
      if (sql.includes('FROM batch_memberships') || sql.includes('FROM student_enrollments') || sql.includes('FROM curriculum_standards')) {
        return { rows: [] };
      }
      if (sql.includes('FROM ai_chat_messages') && sql.includes('ORDER BY created_at DESC')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await runTutorTurn({ execute }, {
      user: { user_id: 'u_1', role: 'student', username: 'aa12' },
      schoolId: 'school_1',
      username: 'aa12',
      question: 'What is my growth edge?',
      callModel: async () => ({
        result: {
          reply: 'Your growth edge is calibration - check units before finishing.',
          citations: [],
          suggested_next: 'Ask about a specific exam question',
        },
        model: 'deepseek-chat',
      }),
    });

    expect(result.reply).toMatch(/calibration/i);
    expect(result.sessionId).toMatch(/^tut_/);
    const inserts = execute.mock.calls.filter(([arg]) => String(arg.sql || '').includes('INSERT INTO ai_chat_messages'));
    expect(inserts).toHaveLength(2);
  });
});
