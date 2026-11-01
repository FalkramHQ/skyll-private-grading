// src/test/kcAllowlist.test.js
import { describe, it, expect } from 'vitest';
import { buildKcAllowlist } from '../../api/_lib/kcAllowlist.js';

const KC_ROWS = [
  { id: 'kc_a', kc_label: 'Inverse trig identities', kc_slug: 'itr_identities', cognitive_level: 'analyze' },
  { id: 'kc_b', kc_label: 'Integration by parts', kc_slug: 'int_parts', cognitive_level: 'apply' },
];

function makeDb() {
  const calls = [];
  return {
    calls,
    async execute({ sql, args }) {
      calls.push({ sql, args });
      if (sql.includes('FROM knowledge_components')) {
        return { rows: KC_ROWS };
      }
      return { rows: [] };
    },
  };
}

describe('kcAllowlist', () => {
  it('returns KC id→label map filtered by board/grade/subject', async () => {
    const db = makeDb();
    const allow = await buildKcAllowlist(db, { board: 'CBSE', grade: '12th', subject: 'Mathematics' });
    expect(allow.byId).toEqual({
      kc_a: { label: 'Inverse trig identities', slug: 'itr_identities', cognitive: 'analyze' },
      kc_b: { label: 'Integration by parts', slug: 'int_parts', cognitive: 'apply' },
    });
    expect(allow.validIds.has('kc_a')).toBe(true);
    expect(allow.validIds.has('kc_x')).toBe(false);
  });

  it('passes args to the DB as [board, grade, subject]', async () => {
    const db = makeDb();
    await buildKcAllowlist(db, { board: 'CBSE', grade: '12th', subject: 'Mathematics' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].args).toEqual(['CBSE', '12th', 'Mathematics']);
  });

  it('returns an empty allowlist when the query returns no rows', async () => {
    const emptyDb = {
      async execute() {
        return { rows: [] };
      },
    };
    const allow = await buildKcAllowlist(emptyDb, { board: 'CBSE', grade: '10th', subject: 'Science' });
    expect(allow.byId).toEqual({});
    expect(allow.validIds).toBeInstanceOf(Set);
    expect(allow.validIds.size).toBe(0);
  });
});
