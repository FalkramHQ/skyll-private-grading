/**
 * Class DNA + concept mastery aggregation (deterministic, evidence-bound).
 * Pure helpers — no DB I/O.
 */

function text(value) {
  return String(value || '').trim();
}

/** Keep letters/marks/numbers across scripts (Latin + Devanagari conjuncts, etc.). */
export function normalizeTopicKey(value) {
  return text(value)
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function masteryStatus(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return 'unknown';
  const value = Number(pct);
  if (value >= 75) return 'ready';
  if (value >= 50) return 'developing';
  return 'at_risk';
}

/**
 * Aggregate topic_mastery across many DNA profiles for a class.
 * @param {Array<object|null>} dnaList — parsed dna_json objects
 * @param {{ limit?: number }} [opts]
 */
export function aggregateClassTopicMastery(dnaList = [], { limit = 16 } = {}) {
  const byTopic = new Map();

  for (const dna of dnaList) {
    const rows = Array.isArray(dna?.topic_mastery) ? dna.topic_mastery : [];
    const seen = new Set();
    for (const row of rows) {
      const topic = text(row.topic);
      const key = normalizeTopicKey(topic);
      if (!topic || !key || seen.has(key)) continue;
      seen.add(key);
      const pct = row.pct == null ? null : Number(row.pct);
      if (pct == null || Number.isNaN(pct)) continue;
      const entry = byTopic.get(key) || {
        topic,
        sumPct: 0,
        studentCount: 0,
        evidenceCount: 0,
      };
      entry.sumPct += Math.max(0, Math.min(100, pct));
      entry.studentCount += 1;
      entry.evidenceCount += Array.isArray(row.evidence_ids)
        ? row.evidence_ids.length
        : Number(row.total_questions || 0) || 1;
      // Prefer the more specific / longer label when keys collide loosely.
      if (topic.length > entry.topic.length) entry.topic = topic;
      byTopic.set(key, entry);
    }
  }

  const topics = [...byTopic.values()]
    .map((entry) => {
      const avgPct = Math.round(entry.sumPct / Math.max(1, entry.studentCount));
      return {
        topic: entry.topic,
        avgPct,
        studentCount: entry.studentCount,
        evidenceCount: entry.evidenceCount,
        status: masteryStatus(avgPct),
      };
    })
    .sort((a, b) => a.avgPct - b.avgPct || b.studentCount - a.studentCount);

  const max = Math.max(1, Math.min(40, Number(limit) || 16));
  return {
    topics: topics.slice(0, max),
    weakest: topics.filter((row) => row.status === 'at_risk').slice(0, 6),
    strongest: [...topics].sort((a, b) => b.avgPct - a.avgPct).slice(0, 6),
    totals: {
      topics: topics.length,
      atRisk: topics.filter((row) => row.status === 'at_risk').length,
      developing: topics.filter((row) => row.status === 'developing').length,
      ready: topics.filter((row) => row.status === 'ready').length,
    },
  };
}

/**
 * Pack class DNA aggregation for API responses.
 */
export function buildClassDnaAggregate({
  primaryModes = [],
  growthEdges = [],
  dnaProfiles = [],
  profileCount = 0,
  signalCount = 0,
  classFilter = null,
} = {}) {
  const mastery = aggregateClassTopicMastery(dnaProfiles);
  return {
    classFilter: classFilter || null,
    primaryModes,
    growthEdges,
    mastery,
    totals: {
      dnaProfiles: Number(profileCount) || dnaProfiles.length || 0,
      activeSignals: Number(signalCount) || 0,
      topicsTracked: mastery.totals.topics,
    },
  };
}
