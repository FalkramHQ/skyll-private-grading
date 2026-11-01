/**
 * Canonical report action-item shapes used by report payloads + UI.
 *
 * strategies[]:       { topic, strategy, challenge? }
 * recommendations[]:  { topic, action, priority, tip? }
 *
 * Writers must persist objects. Readers may still coerce legacy strings
 * through these helpers until backfill is complete.
 */

const PRIORITIES = new Set(['critical', 'quick_win', 'important']);

function asText(value, max = 700) {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max).trim() : text;
}

function firstTopic(text, fallback = 'Next practice') {
  const clean = asText(text, 160);
  if (!clean) return fallback;
  const sentence = clean.split(/[.!?]/)[0].trim() || clean;
  if (sentence.length <= 60) return sentence;
  const truncated = sentence.slice(0, 57).replace(/\s+\S*$/, '').trim();
  return truncated ? `${truncated}…` : fallback;
}

export function normalizeStrategy(item, index = 0) {
  if (item == null) return null;

  if (typeof item === 'string') {
    const strategy = asText(item);
    if (!strategy) return null;
    return {
      topic: firstTopic(strategy, `Strategy ${index + 1}`),
      strategy,
    };
  }

  if (typeof item !== 'object' || Array.isArray(item)) return null;

  const strategy = asText(item.strategy || item.action || item.challenge || '');
  const topic = asText(item.topic || item.title, 120) || firstTopic(strategy, `Strategy ${index + 1}`);
  if (!strategy && !topic) return null;

  const out = {
    topic,
    strategy: strategy || topic,
  };
  const challenge = asText(item.challenge);
  if (challenge && challenge !== out.strategy) out.challenge = challenge;
  return out;
}

export function normalizeRecommendation(item, index = 0) {
  if (item == null) return null;

  if (typeof item === 'string') {
    const action = asText(item);
    if (!action) return null;
    return {
      topic: firstTopic(action, `Step ${index + 1}`),
      action,
      priority: 'important',
    };
  }

  if (typeof item !== 'object' || Array.isArray(item)) return null;

  const action = asText(item.action || item.strategy || item.tip || '');
  const topic = asText(item.topic || item.title, 120) || firstTopic(action, `Step ${index + 1}`);
  if (!action && !topic) return null;

  const out = {
    topic,
    action: action || topic,
    priority: PRIORITIES.has(item.priority) ? item.priority : 'important',
  };
  const tip = asText(item.tip);
  if (tip && tip !== out.action) out.tip = tip;
  return out;
}

export function normalizeStrategies(list, fallback = []) {
  const source = Array.isArray(list) && list.length ? list : (Array.isArray(fallback) ? fallback : []);
  return source.map((item, index) => normalizeStrategy(item, index)).filter(Boolean).slice(0, 4);
}

export function normalizeRecommendations(list, fallback = []) {
  const source = Array.isArray(list) && list.length ? list : (Array.isArray(fallback) ? fallback : []);
  return source.map((item, index) => normalizeRecommendation(item, index)).filter(Boolean).slice(0, 4);
}

export function needsActionItemBackfill(subject = {}) {
  const strategies = subject?.learning_profile?.strategies;
  const recommendations = subject?.recommendations;
  const hasStringStrategies = Array.isArray(strategies) && strategies.some((item) => typeof item === 'string');
  const hasStringRecommendations = Array.isArray(recommendations) && recommendations.some((item) => typeof item === 'string');
  return hasStringStrategies || hasStringRecommendations;
}

export function backfillSubjectActionItems(subject = {}) {
  if (!subject || typeof subject !== 'object') return { subject, changed: false };
  if (!needsActionItemBackfill(subject)) return { subject, changed: false };

  const next = {
    ...subject,
    recommendations: normalizeRecommendations(subject.recommendations, []),
    learning_profile: {
      ...(subject.learning_profile || {}),
      strategies: normalizeStrategies(subject.learning_profile?.strategies, []),
    },
  };
  return { subject: next, changed: true };
}

export function backfillReportActionItems(payload = {}) {
  if (!payload || typeof payload !== 'object') return { payload, changed: false };
  const subjects = payload?.term1?.subjects;
  if (!Array.isArray(subjects) || !subjects.length) return { payload, changed: false };

  let changed = false;
  const nextSubjects = subjects.map((subject) => {
    const result = backfillSubjectActionItems(subject);
    if (result.changed) changed = true;
    return result.subject;
  });
  if (!changed) return { payload, changed: false };

  return {
    payload: {
      ...payload,
      term1: {
        ...payload.term1,
        subjects: nextSubjects,
      },
    },
    changed: true,
  };
}
