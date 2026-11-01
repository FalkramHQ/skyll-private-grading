// src/test/examMeta.test.js
import { describe, it, expect } from 'vitest';
import { resolveExamMeta } from '../../api/_lib/examMeta.js';

const db = {
  async execute({ sql }) {
    if (sql.includes('FROM exams e LEFT JOIN tests t')) {
      return { rows: [{ subject: 'Mathematics', grade: '12th', source_test_id: 'test_1', name: 'Trig Functions' }] };
    }
    if (sql.includes('FROM exam_question_curriculum_links')) {
      return { rows: [{ board: 'CBSE' }] };
    }
    return { rows: [] };
  },
};

describe('examMeta', () => {
  it('resolves board/grade/subject from exams→tests + curriculum_links', async () => {
    const meta = await resolveExamMeta(db, 'exam_abc');
    expect(meta).toEqual({ board: 'CBSE', grade: '12th', subject: 'Mathematics' });
  });

  it('returns null for a falsy examId without touching the DB', async () => {
    const throwingDb = {
      async execute() {
        throw new Error('db.execute should not be called for falsy examId');
      },
    };
    const meta = await resolveExamMeta(throwingDb, null);
    expect(meta).toBeNull();
  });

  it('returns null when the exams→tests row has no subject', async () => {
    const noSubjectDb = {
      async execute() {
        return { rows: [{ subject: null, grade: null, source_test_id: null, name: null }] };
      },
    };
    const meta = await resolveExamMeta(noSubjectDb, 'exam_abc');
    expect(meta).toBeNull();
  });

  it('defaults to CBSE when the exam has no curriculum links', async () => {
    const unlinkedDb = {
      async execute({ sql }) {
        if (sql.includes('FROM exams e LEFT JOIN tests t')) {
          return { rows: [{ subject: 'Mathematics', grade: '10th', source_test_id: 'test_1', name: 'Algebra' }] };
        }
        if (sql.includes('FROM exam_question_curriculum_links')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const meta = await resolveExamMeta(unlinkedDb, 'exam_abc');
    expect(meta).toEqual({ board: 'CBSE', grade: '10th', subject: 'Mathematics' });
  });
});
