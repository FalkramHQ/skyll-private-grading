import { describe, expect, it } from 'vitest';
import {
  aggregateClassTopicMastery,
  buildClassDnaAggregate,
  masteryStatus,
  normalizeTopicKey,
} from '../../api/_lib/classDna.js';

describe('class DNA + concept mastery', () => {
  it('normalizes Devanagari and Latin topic keys', () => {
    expect(normalizeTopicKey('गद्य')).toBe('गद्य');
    expect(normalizeTopicKey('Electromagnetic Induction!')).toBe('electromagnetic induction');
  });

  it('bands mastery percentages', () => {
    expect(masteryStatus(80)).toBe('ready');
    expect(masteryStatus(55)).toBe('developing');
    expect(masteryStatus(20)).toBe('at_risk');
    expect(masteryStatus(null)).toBe('unknown');
  });

  it('aggregates class topic mastery across DNA profiles', () => {
    const mastery = aggregateClassTopicMastery([
      { topic_mastery: [{ topic: 'EMI', pct: 30, evidence_ids: ['1'] }, { topic: 'Optics', pct: 80 }] },
      { topic_mastery: [{ topic: 'emi', pct: 50, total_questions: 2 }, { topic: 'Waves', pct: 90 }] },
      { topic_mastery: [] },
      null,
    ]);
    const emi = mastery.topics.find((row) => row.topic.toLowerCase() === 'emi');
    expect(emi.studentCount).toBe(2);
    expect(emi.avgPct).toBe(40);
    expect(emi.status).toBe('at_risk');
    expect(mastery.strongest[0].topic).toBe('Waves');
    expect(mastery.totals.topics).toBe(3);
  });

  it('packs class DNA aggregate for API responses', () => {
    const pack = buildClassDnaAggregate({
      primaryModes: [{ modeId: 'maker', count: 3 }],
      growthEdges: [{ modeId: 'calibrator', count: 2 }],
      dnaProfiles: [
        { topic_mastery: [{ topic: 'Journal Entries', pct: 35 }] },
        { topic_mastery: [{ topic: 'Journal Entries', pct: 45 }] },
      ],
      profileCount: 2,
      signalCount: 18,
      classFilter: '10',
    });
    expect(pack.classFilter).toBe('10');
    expect(pack.totals.dnaProfiles).toBe(2);
    expect(pack.totals.topicsTracked).toBe(1);
    expect(pack.mastery.weakest[0].avgPct).toBe(40);
  });
});
