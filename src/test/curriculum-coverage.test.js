import { describe, expect, it } from 'vitest';
import { computeCurriculumCoverage } from '../../api/_lib/curriculumCoverage.js';

function mockDb({ standards = [], links = [], unmapped = 0, proposed = 0, exam = null } = {}) {
  return {
    async execute({ sql }) {
      if (sql.includes('FROM exams e') && sql.includes('WHERE e.id = ?')) {
        return { rows: exam ? [exam] : [] };
      }
      if (sql.includes('FROM curriculum_standards')) {
        return {
          rows: standards.map((row) => ({
            id: row.id,
            board: row.board,
            grade: row.grade,
            subject: row.subject,
            topic: row.topic,
            sub_topics_json: '[]',
            difficulty_weight: null,
            created_at: '2026-01-01',
          })),
        };
      }
      if (sql.includes('COUNT(*) AS c') && sql.includes("l.status = 'proposed'")) {
        return { rows: [{ c: proposed }] };
      }
      if (sql.includes('COUNT(*) AS c') && sql.includes('l.id IS NULL')) {
        return { rows: [{ c: unmapped }] };
      }
      if (sql.includes('exam_question_curriculum_links')) {
        return { rows: links };
      }
      return { rows: [] };
    },
  };
}

describe('computeCurriculumCoverage', () => {
  it('splits tested vs missing topics from approved links', async () => {
    const coverage = await computeCurriculumCoverage(mockDb({
      standards: [
        { id: 'c1', board: 'CBSE', grade: '11', subject: 'Mathematics', topic: 'Sets' },
        { id: 'c2', board: 'CBSE', grade: '11', subject: 'Mathematics', topic: 'Relations' },
        { id: 'c3', board: 'CBSE', grade: '11', subject: 'Mathematics', topic: 'Trigonometry' },
      ],
      links: [
        { standard_id: 'c1', topic: 'Sets', grade: '11', board: 'CBSE', status: 'approved', question_count: 2 },
        { standard_id: 'c3', topic: 'Trigonometry', grade: '11', board: 'CBSE', status: 'approved', question_count: 1 },
      ],
      unmapped: 4,
      proposed: 1,
    }), {
      schoolId: 'school_1',
      board: 'CBSE',
      grade: '11',
      subject: 'Mathematics',
    });

    expect(coverage.totals.standards).toBe(3);
    expect(coverage.totals.tested).toBe(2);
    expect(coverage.totals.missing).toBe(1);
    expect(coverage.missing[0].topic).toBe('Relations');
    expect(coverage.pctCovered).toBeCloseTo(66.7, 0);
    expect(coverage.totals.unmappedQuestions).toBe(4);
    expect(coverage.totals.pendingLinks).toBe(1);
  });

  it('requires a subject', async () => {
    const coverage = await computeCurriculumCoverage(mockDb(), { schoolId: 'school_1' });
    expect(coverage.note).toMatch(/subject is required/i);
    expect(coverage.pctCovered).toBeNull();
  });

  it('reports 100% coverage when all standards are tested with approved links', async () => {
    const coverage = await computeCurriculumCoverage(mockDb({
      standards: [
        { id: 'c1', board: 'CBSE', grade: '11', subject: 'Mathematics', topic: 'Sets' },
      ],
      links: [
        { standard_id: 'c1', topic: 'Sets', grade: '11', board: 'CBSE', status: 'approved', question_count: 5 },
      ],
    }), { schoolId: 'school_1', subject: 'Mathematics' });
    expect(coverage.totals.standards).toBe(1);
    expect(coverage.totals.tested).toBe(1);
    expect(coverage.totals.missing).toBe(0);
    expect(coverage.pctCovered).toBe(100);
  });

  it('reports 0% coverage when standards exist but no approved links are present', async () => {
    const coverage = await computeCurriculumCoverage(mockDb({
      standards: [
        { id: 'c1', board: 'CBSE', grade: '11', subject: 'Mathematics', topic: 'Sets' },
      ],
      links: [],
    }), { schoolId: 'school_1', subject: 'Mathematics' });
    expect(coverage.totals.standards).toBe(1);
    expect(coverage.totals.tested).toBe(0);
    expect(coverage.totals.missing).toBe(1);
    expect(coverage.pctCovered).toBe(0);
  });

  it('handles empty standards and zero questions without division by zero errors', async () => {
    const coverage = await computeCurriculumCoverage(mockDb({ standards: [], links: [] }), {
      schoolId: 'school_1',
      subject: 'Mathematics',
    });
    expect(coverage.totals).toMatchObject({ standards: 0, tested: 0, missing: 0 });
    expect(coverage.pctCovered).toBeNull();
  });
});

