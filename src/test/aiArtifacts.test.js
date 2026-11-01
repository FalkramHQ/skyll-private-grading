import { describe, expect, it } from 'vitest';
import { listAiArtifacts, saveAiArtifact } from '../../api/_lib/aiArtifacts.js';

describe('ai artifacts', () => {
  it('saves and lists artifacts scoped by school and user', async () => {
    const written = [];
    const db = {
      execute: async ({ sql, args }) => {
        if (sql.startsWith('INSERT INTO ai_artifacts')) {
          written.push(args);
          return { rows: [] };
        }
        return {
          rows: [{
            id: 'aa_1',
            artifact_type: 'lesson_plan',
            scope_json: JSON.stringify({ className: '9A', subject: 'Mathematics' }),
            payload_json: JSON.stringify({ title: 'Circles recap' }),
            created_at: '2026-08-05T00:00:00.000Z',
          }],
        };
      },
    };
    const id = await saveAiArtifact(db, {
      schoolId: 'school_1',
      userId: 'u1',
      type: 'lesson_plan',
      scope: { className: '9A', subject: 'Mathematics' },
      payload: { title: 'Circles recap' },
    });
    expect(id).toMatch(/^aa_/);
    expect(written[0][1]).toBe('school_1');

    const artifacts = await listAiArtifacts(db, { schoolId: 'school_1', userId: 'u1' });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ type: 'lesson_plan', payload: { title: 'Circles recap' } });
    expect(artifacts[0].scope.className).toBe('9A');
  });

  it('requires school scoping', async () => {
    const db = { execute: async () => ({ rows: [] }) };
    await expect(saveAiArtifact(db, { type: 'quiz', payload: {} })).rejects.toThrow('schoolId');
    await expect(listAiArtifacts(db, {})).rejects.toThrow('schoolId');
  });
});
