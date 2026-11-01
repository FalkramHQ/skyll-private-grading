import { describe, expect, it } from 'vitest';
import {
  LIFECYCLES,
  STUDENT_STATUSES,
  assertTransition,
  canTransition,
  derivePersonLifecycle,
  nextStates,
} from '../../../shared/crm/lifecycles.js';

describe('CRM lifecycle contracts', () => {
  it('only lists transitions between known states', () => {
    for (const [name, machine] of Object.entries(LIFECYCLES)) {
      for (const { from, to } of machine.transitions) {
        expect(machine.states, `${name} ${from}`).toContain(from);
        expect(machine.states, `${name} ${to}`).toContain(to);
      }
    }
  });

  it('rejects every pair that is not listed', () => {
    for (const [name, machine] of Object.entries(LIFECYCLES)) {
      const listed = new Set(machine.transitions.map(({ from, to }) => `${from}>${to}`));
      for (const from of machine.states) {
        for (const to of machine.states) {
          if (listed.has(`${from}>${to}`)) continue;
          expect(canTransition(name, from, to, { via: 'convert' }), `${name} ${from}>${to}`).toBe(false);
          expect(() => assertTransition(name, from, to, { via: 'convert', reason: 'x' })).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
        }
      }
    }
  });

  it('allows every listed transition when its conditions are met', () => {
    for (const [name, machine] of Object.entries(LIFECYCLES)) {
      for (const transition of machine.transitions) {
        expect(assertTransition(name, transition.from, transition.to, { via: transition.via, reason: 'documented' })).toBe(transition);
      }
    }
  });

  it('reaches won only through conversion, never by moving stages', () => {
    expect(canTransition('leadStage', 'open', 'won')).toBe(false);
    expect(canTransition('leadStage', 'applicant', 'won')).toBe(false);
    expect(canTransition('leadStage', 'applicant', 'won', { via: 'convert' })).toBe(true);
    expect(canTransition('leadStage', 'lost', 'won', { via: 'convert' })).toBe(false);
    expect(nextStates('leadStage', 'open')).not.toContain('won');
    expect(nextStates('leadStage', 'open', { via: 'convert' })).toContain('won');
  });

  it('requires a reason where the contract says so', () => {
    const cases = [
      ['leadStage', 'open', 'lost'],
      ['attendance', 'present', 'absent'],
      ['invoice', 'issued', 'void'],
      ['refund', 'requested', 'rejected'],
    ];
    for (const [name, from, to] of cases) {
      expect(() => assertTransition(name, from, to, { reason: '  ' })).toThrow(expect.objectContaining({ code: 'reason_required' }));
      expect(() => assertTransition(name, from, to, { reason: 'fees too high' })).not.toThrow();
    }
    expect(() => assertTransition('attendance', 'unmarked', 'present')).not.toThrow();
  });

  it('keeps the student status vocabulary, including alumni', () => {
    expect(STUDENT_STATUSES).toEqual(['active', 'inactive', 'alumni', 'archived']);
    expect(canTransition('studentStatus', 'alumni', 'active')).toBe(true);
    expect(canTransition('studentStatus', 'archived', 'active')).toBe(false);
  });

  it('treats a succeeded payment as final', () => {
    expect(nextStates('payment', 'succeeded')).toEqual([]);
  });

  it('derives the person lifecycle from the canonical student before the lead', () => {
    expect(derivePersonLifecycle({ stageCategory: 'open' })).toBe('lead');
    expect(derivePersonLifecycle({ stageCategory: 'applicant' })).toBe('applicant');
    expect(derivePersonLifecycle({ stageCategory: 'lost' })).toBe('lost');
    expect(derivePersonLifecycle({ stageCategory: 'won', studentStatus: 'active' })).toBe('enrolled');
    expect(derivePersonLifecycle({ stageCategory: 'won', studentStatus: 'alumni' })).toBe('alumni');
    expect(derivePersonLifecycle({})).toBe(null);
  });
});
