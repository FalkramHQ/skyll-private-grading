// Pure utility functions shared across the processing worker.
// Extracted from index.js for maintainability.

export function now() { return new Date().toISOString(); }

export function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

export function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

export function text(value, limit = 12000) {
  return String(value || '').trim().slice(0, limit);
}

export function scoreStatus(marks, total, attempted = true) {
  if (!attempted) return 'not_attempted';
  if (Number(marks) >= Number(total)) return 'correct';
  return Number(marks) > 0 ? 'partial' : 'incorrect';
}

const learningModeIds = new Set(['architect', 'pathfinder', 'maker', 'cartographer', 'calibrator', 'bridgebuilder']);

export function textList(value, fallback = []) {
  const values = Array.isArray(value) ? value : fallback;
  return values.map((item) => text(item, 700)).filter(Boolean).slice(0, 4);
}

export function initialDnaFallback(questions) {
  const total = questions.reduce((sum, question) => sum + Number(question.marks_total || 0), 0);
  const score = questions.reduce((sum, question) => sum + Number(question.marks_obtained || 0), 0);
  const correct = questions.filter((question) => Number(question.marks_obtained) >= Number(question.marks_total) && Number(question.marks_total) > 0);
  const missed = questions.filter((question) => Number(question.marks_obtained) < Number(question.marks_total));
  const ratio = score / Math.max(total, 1);
  const primary = ratio >= 0.75 ? 'calibrator' : ratio >= 0.45 ? 'pathfinder' : 'maker';
  const edge = ratio >= 0.75 ? 'architect' : 'calibrator';
  return {
    schema_version: 2,
    assessment_scope: { level: 'assessment_snapshot', detail: 'This profile reflects evidence from this assessment and becomes more precise as further assessments are added.' },
    primary_mode: {
      mode_id: primary,
      description: correct.length ? `This assessment shows reliable performance on ${correct.slice(0, 3).map((question) => question.number).join(', ')}.` : 'This assessment offers limited evidence of a stable working pattern yet.',
      evidence: correct.length ? `Full-credit evidence: ${correct.slice(0, 3).map((question) => question.number).join(', ')}.` : 'No full-credit question was observed in this assessment.',
    },
    growth_edge: {
      mode_id: edge,
      action: missed.length ? `Rebuild the method for ${missed.slice(0, 3).map((question) => question.number).join(', ')} before attempting similar problems.` : 'Use the same clear working structure on a fresh mixed set.',
      evidence: missed.length ? `Marks were lost on ${missed.slice(0, 3).map((question) => question.number).join(', ')}.` : 'No marks were lost in this assessment.',
    },
    dimensions: [
      { id: primary, state: ratio >= 0.75 ? 'secure' : ratio >= 0.45 ? 'developing' : 'needs_practice', score: Math.round(ratio * 100), evidence_count: correct.length, evidence_question_ids: correct.slice(0, 4).map((question) => String(question.number)) },
      { id: edge, state: missed.length ? 'needs_practice' : 'secure', score: Math.round(ratio * 100), evidence_count: missed.length, evidence_question_ids: missed.slice(0, 4).map((question) => String(question.number)) },
    ],
    next_move: {
      title: missed.length ? `Repair ${missed[0].number} before the next practice set` : 'Transfer this accuracy to a mixed practice set',
      action: missed.length ? `Compare your method for ${missed[0].number} with the solution, then solve one similar question without notes.` : 'Attempt mixed questions without notes and keep the same final-answer checks.',
    },
  };
}

export function initialModulesFallback(questions) {
  const full = questions.filter((question) => Number(question.marks_obtained) >= Number(question.marks_total) && Number(question.marks_total) > 0);
  const lost = questions.filter((question) => Number(question.marks_obtained) < Number(question.marks_total));
  const strongest = full.slice(0, 3).map((question) => `${question.number}: ${question.topic || 'the required method'}`);
  const focus = lost.slice(0, 3).map((question) => `${question.number}: ${question.topic || 'the required method'}`);
  return {
    subject: {
      overall_insights: strongest.length ? `Reliable work was visible in ${strongest.join('; ')}.` : 'This assessment does not yet show a consistently reliable method.',
      strengths: strongest.length ? strongest : ['No full-credit pattern was observed in this assessment.'],
      misconceptions: focus.length ? focus.map((item) => `Revisit ${item}.`) : [],
      recommendations: focus.length
        ? focus.map((item) => ({
          topic: item,
          action: `Rework ${item} from the method, then attempt one similar question without notes.`,
          priority: 'important',
        }))
        : [{ topic: 'Mixed practice', action: 'Use a mixed practice set to reinforce the methods that were correct.', priority: 'important' }],
      root_cause: focus.length ? `The main opportunity is converting partial or incomplete working into a checked final answer on ${focus.join(', ')}.` : 'The current evidence supports consolidation rather than a specific remediation theme.',
      learning_profile: {
        core_strength: strongest.length ? `Full credit on ${strongest.join(', ')} shows that these methods can be applied accurately.` : 'A stable strength needs more successful question evidence.',
        pattern_recognition: focus.length ? `Marks were concentrated in ${focus.join(', ')}; target these questions before broad revision.` : 'No repeated loss pattern was observed in this assessment.',
        root_cause_analysis: focus.length ? 'Use the question-by-question feedback to separate a missing method step from a final-answer check.' : 'Continue using clear working and final-answer checks.',
        strategies: focus.length
          ? focus.map((item) => ({
            topic: item,
            strategy: `For ${item}, state the method first, complete the working, then box-check the final answer.`,
          }))
          : [{ topic: 'Method check', strategy: 'Keep showing the method and verify the final answer before moving on.' }],
      },
    },
    learnerDna: initialDnaFallback(questions),
  };
}

export { learningModeIds };
