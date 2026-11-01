import { describe, expect, it, vi } from 'vitest';
import {
  findBestCurriculumMatch,
  listCurriculumStandards,
  scoreTopicMatch,
  upsertQuestionCurriculumLink,
} from '../../api/_lib/curriculumMap.js';
import { importExamQuestionToBank, listQuestionBank, upsertQuestionBankItem } from '../../api/_lib/questionBank.js';

describe('curriculum map', () => {
  it('scores exact and fuzzy topic matches', () => {
    const standard = {
      id: 'icse_10_math_trig_identities',
      topic: 'Trigonometric Identities',
      subTopics: ['sin²+cos²=1', 'proving identities'],
    };
    expect(scoreTopicMatch('Trigonometric Identities', standard)).toBe(1);
    expect(scoreTopicMatch('trig identities', standard)).toBeGreaterThan(0.45);
    expect(scoreTopicMatch('Banking', standard)).toBe(0);
  });

  it('picks the best match above the threshold', () => {
    const standards = [
      { id: 'icse_10_math_banking', topic: 'Banking', subTopics: [] },
      { id: 'icse_10_math_trig_identities', topic: 'Trigonometric Identities', subTopics: ['identities'] },
    ];
    const match = findBestCurriculumMatch('Prove sin^2+cos^2 identities', standards);
    expect(match.standard.id).toBe('icse_10_math_trig_identities');
    expect(match.score).toBeGreaterThan(0.45);
  });

  it('matches SrSec live free-text topics via subTopics / science boosts', () => {
    const standards = [
      {
        id: 'cbse_11_chem_basic_concepts',
        topic: 'Some Basic Concepts of Chemistry',
        subTopics: ['mole concept', 'stoichiometry'],
      },
      {
        id: 'cbse_12_chem_solutions',
        topic: 'Solutions',
        subTopics: ['colligative properties', "van't hoff factor", 'concentration terms'],
      },
      {
        id: 'cbse_12_phys_emi',
        topic: 'Electromagnetic Induction',
        subTopics: ['faraday law', 'electromagnetic induction'],
      },
      {
        id: 'cbse_12_math_inverse_trig',
        topic: 'Inverse Trigonometric Functions',
        subTopics: ['principal value'],
      },
    ];
    expect(findBestCurriculumMatch('Mole Concept', standards).standard.id).toBe('cbse_11_chem_basic_concepts');
    expect(findBestCurriculumMatch("Van't Hoff Factor", standards).standard.id).toBe('cbse_12_chem_solutions');
    expect(findBestCurriculumMatch('Concentration Terms', standards).standard.id).toBe('cbse_12_chem_solutions');
    expect(findBestCurriculumMatch('Electromagnetic Induction', standards).standard.id).toBe('cbse_12_phys_emi');
    expect(findBestCurriculumMatch('Inverse Trigonometric Functions', standards).standard.id).toBe('cbse_12_math_inverse_trig');

    const bio = [
      {
        id: 'cbse_12_bio_sexual_reproduction_plants',
        topic: 'Sexual Reproduction in Flowering Plants',
        subTopics: ['reproduction in lower and higher plants', 'pollination'],
      },
      {
        id: 'cbse_12_bio_human_reproduction',
        topic: 'Human Reproduction',
        subTopics: ['gametogenesis'],
      },
    ];
    expect(findBestCurriculumMatch('Reproduction in Lower and Higher Plants', bio).standard.id)
      .toBe('cbse_12_bio_sexual_reproduction_plants');
  });

  it('lists standards with filters and upserts question links', async () => {
    const execute = vi.fn(async (arg) => {
      const sql = String(arg.sql || '');
      if (sql.includes('FROM curriculum_standards')) {
        return {
          rows: [{
            id: 'icse_10_math_quadratic',
            board: 'ICSE',
            grade: '10th',
            subject: 'Mathematics',
            topic: 'Quadratic Equations',
            sub_topics_json: '["formula"]',
            difficulty_weight: 0.65,
            created_at: '2026-08-01T00:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    });
    const db = { execute };

    const rows = await listCurriculumStandards(db, { board: 'ICSE', grade: '10th', subject: 'Mathematics' });
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe('Quadratic Equations');

    await upsertQuestionCurriculumLink(db, {
      examSetQuestionId: 'esq_1',
      curriculumStandardId: 'icse_10_math_quadratic',
      sourceTopic: 'Quadratics',
      confidence: 0.8,
    });
    expect(execute.mock.calls.some(([arg]) => String(arg.sql).includes('INSERT INTO exam_question_curriculum_links'))).toBe(true);
  });
});

describe('question bank', () => {
  it('filters by board/grade/subject/topic/difficulty', async () => {
    const execute = vi.fn(async (arg) => {
      expect(String(arg.sql)).toContain('FROM question_bank');
      expect(arg.args).toEqual(['ICSE', '10th', 'Mathematics', 'medium', 'active', '%trig%', 10]);
      return {
        rows: [{
          id: 'qb_1',
          board: 'ICSE',
          grade: '10th',
          subject: 'Mathematics',
          topic: 'Trigonometric Identities',
          curriculum_standard_id: 'icse_10_math_trig_identities',
          difficulty: 'medium',
          question_type: 'subjective',
          question_text: 'Prove that…',
          answer_key: '…',
          rubric_json: '{}',
          max_marks: 3,
          source: 'ai_generated',
          source_exam_id: null,
          source_exam_set_question_id: null,
          quality_score: 0.9,
          status: 'active',
          created_at: '2026-08-01T00:00:00.000Z',
          updated_at: '2026-08-01T00:00:00.000Z',
        }],
      };
    });

    const rows = await listQuestionBank({ execute }, {
      board: 'ICSE',
      grade: '10th',
      subject: 'Mathematics',
      topic: 'Trig',
      difficulty: 'medium',
      limit: 10,
    });
    expect(rows[0].id).toBe('qb_1');
    expect(rows[0].curriculumStandardId).toBe('icse_10_math_trig_identities');
  });

  it('upserts and imports exam questions without embeddings', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const db = { execute };

    const created = await upsertQuestionBankItem(db, {
      board: 'CBSE',
      grade: '9th',
      subject: 'Mathematics',
      topic: 'Polynomials',
      difficulty: 'easy',
      questionText: 'Factorise x^2 - 5x + 6',
      answerKey: '(x-2)(x-3)',
      source: 'teacher_curated',
    });
    expect(created.id).toMatch(/^qb_/);
    const insertSql = String(execute.mock.calls[0][0].sql);
    expect(insertSql).toContain('INSERT INTO question_bank');
    expect(insertSql).toContain('embedding');

    await importExamQuestionToBank(db, {
      examSetQuestion: {
        id: 'esq_9',
        question_text: 'Find the mean',
        answer_key_text: '42',
        max_marks: 2,
        rubric_json: JSON.stringify({ topic: 'Statistics', expected_response_type: 'numerical' }),
      },
      board: 'CBSE',
      grade: '9th',
      curriculumStandardId: 'cbse_9_math_statistics',
      sourceExamId: 'exam_1',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
