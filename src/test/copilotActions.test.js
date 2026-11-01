import { describe, expect, it } from 'vitest';
import { routeCopilotAction } from '../lib/copilotActions';

describe('routeCopilotAction', () => {
  it('routes quiz-like actions to quiz-gen', () => {
    expect(routeCopilotAction('Generate a 5-item quiz on Trigonometry'))
      .toEqual({ kind: 'quiz-gen', topic: 'Generate a 5-item quiz on Trigonometry' });
  });

  it('routes lesson/reteach actions to lesson-plan', () => {
    expect(routeCopilotAction('Reteach balancing redox equations tomorrow'))
      .toEqual({ kind: 'lesson-plan', topic: 'Reteach balancing redox equations tomorrow' });
  });

  it('routes intervention actions to intervention', () => {
    expect(routeCopilotAction('Set up a small-group intervention for the bottom segment'))
      .toEqual({ kind: 'intervention', topic: 'Set up a small-group intervention for the bottom segment' });
  });

  it('falls back to prefilling the copilot input', () => {
    expect(routeCopilotAction('Check the roster for duplicates'))
      .toEqual({ kind: 'copilot', topic: 'Check the roster for duplicates' });
    expect(routeCopilotAction(null)).toEqual({ kind: 'copilot', topic: '' });
  });
});
