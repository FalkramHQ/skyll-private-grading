export const LEARNING_MODES = [
  { id: 'architect', label: 'The Architect', capability: 'Concept building' },
  { id: 'pathfinder', label: 'The Pathfinder', capability: 'Problem interpretation and method selection' },
  { id: 'maker', label: 'The Maker', capability: 'Execution and completion' },
  { id: 'cartographer', label: 'The Cartographer', capability: 'Representation across diagrams, notation, equations, graphs, and data' },
  { id: 'calibrator', label: 'The Calibrator', capability: 'Verification and correction' },
  { id: 'bridgebuilder', label: 'The Bridgebuilder', capability: 'Transfer to a changed question form or context' },
];

const asArray = (value) => (Array.isArray(value) ? value : []);
const allowedStates = new Set(['secure', 'developing', 'needs_practice', 'not_observed']);
const modeById = new Map(LEARNING_MODES.map((mode) => [mode.id, mode]));

function stateForLegacyLevel(level) {
  const normalized = String(level || '').trim().toLowerCase();
  if (['secure', 'strong', 'high'].includes(normalized)) return 'secure';
  if (['needs_practice', 'needs work', 'low'].includes(normalized)) return 'needs_practice';
  return 'developing';
}

function modeIdFor(value) {
  const source = String(value || '').toLowerCase();
  return LEARNING_MODES.find((mode) => source.includes(mode.id) || source.includes(mode.label.toLowerCase()))?.id || null;
}

function normalizeDimension(input, mode) {
  const evidenceCount = Math.max(0, Number(input?.evidence_count) || 0);
  const evidenceQuestionIds = asArray(input?.evidence_question_ids).filter(Boolean).map(String);
  const rawState = allowedStates.has(input?.state) ? input.state : stateForLegacyLevel(input?.level);
  // A single response is an observation, not a dependable capability claim.
  const state = evidenceCount === 0
    ? 'not_observed'
    : evidenceCount === 1 && rawState === 'secure'
      ? 'developing'
      : rawState;
  const score = typeof input?.score === 'number' && Number.isFinite(input.score) ? input.score : null;

  return {
    id: mode.id,
    label: `${mode.label} - ${mode.capability}`,
    state,
    score,
    evidence_count: evidenceCount,
    evidence_question_ids: evidenceQuestionIds,
  };
}

function canonicalDimensions(dna) {
  const rawDimensions = asArray(dna?.dimensions);
  return LEARNING_MODES.map((mode) => {
    const match = rawDimensions.find((dimension) => modeIdFor(dimension?.id || dimension?.label || dimension?.name) === mode.id);
    return normalizeDimension(match, mode);
  });
}

function scopeFor(dna) {
  const source = dna?.assessment_scope || {};
  const level = source.level || 'assessment_snapshot';
  if (level === 'longitudinal_dna') {
    return { label: 'Longitudinal learner profile', detail: source.detail || 'This profile is based on repeated evidence across assessments and subjects.' };
  }
  if (level === 'subject_profile') {
    return { label: 'Subject learning profile', detail: source.detail || 'This profile is based on repeated evidence within this subject.' };
  }
  return { label: 'Assessment snapshot', detail: source.detail || 'This profile describes evidence from the current assessment. It is a guide for practice, not a fixed label.' };
}

function firstObservedMode(dimensions, key = 'secure') {
  return dimensions.find((dimension) => dimension.state === key) || dimensions.find((dimension) => dimension.state === 'developing') || null;
}

/**
 * Normalize every stored profile to the evidence-bound v2 display contract.
 * Historic free-form persona fields are intentionally not surfaced.
 */
export function normalizeLearnerDna(dna) {
  if (!dna) return null;

  const dimensions = canonicalDimensions(dna);
  const scope = scopeFor(dna);
  const primary = dna.primary_mode || {};
  const growth = dna.growth_edge || {};
  const primaryMode = modeById.get(primary.mode_id || modeIdFor(primary.title)) || firstObservedMode(dimensions);
  const growthMode = modeById.get(growth.mode_id || modeIdFor(growth.title)) || dimensions.find((dimension) => dimension.state === 'needs_practice');
  const evidence = dna.identity?.evidence || dna.narrative || primary.evidence || scope.detail;

  return {
    schema_version: 2,
    assessment_scope: scope,
    identity: {
      label: primaryMode ? primaryMode.label : 'Current learning snapshot',
      subtitle: primaryMode
        ? `${primaryMode.capability}. This is an evidence-bound working signal, not a fixed type.`
        : 'This assessment does not yet contain enough evidence to name a learning mode.',
      evidence,
    },
    primary_mode: {
      mode_id: primaryMode?.id || null,
      title: primary.title || (primaryMode ? `${primaryMode.label}: ${primaryMode.capability}` : 'What this assessment can confirm'),
      description: primary.description || dna.how_you_learn || 'Use the question-level feedback to build a clearer picture over later assessments.',
      evidence: primary.evidence || evidence,
    },
    growth_edge: {
      mode_id: growthMode?.id || null,
      title: growth.title || (growthMode ? `Strengthen ${growthMode.label}` : 'Choose one next skill to practise'),
      action: growth.action || dna.biggest_lever?.action || 'Choose one missed question, compare your method with the solution, and solve a similar question without looking at the answer.',
      evidence: growth.evidence || 'This becomes a stronger pattern only when the same signal repeats in later evidence.',
    },
    dimensions,
    next_move: dna.next_move || {
      title: 'Turn the feedback into a repeatable habit',
      action: 'Choose one missed question, compare your method with the solution, and solve a similar question without looking at the answer.',
    },
  };
}
