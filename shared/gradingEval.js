// Grading evaluation set: build de-identified items from adjudicated review folders,
// and score a grading run against their ground truth. Pure functions only; the CLI
// in scripts/evalGrading.mjs does the file and network work.
//
// Ground truth per question:
//   - adjudicated disagreement -> the adjudicator's correct_mark
//   - pipeline and independent grade identical -> that mark
//   - otherwise (under a mark apart, or unadjudicated) -> left out

const SUBJECT_PREFIXES = [
  ['chem', 'Chemistry'], ['maths', 'Mathematics'], ['phys', 'Physics'], ['eng', 'English'],
  ['hindi', 'Hindi'], ['german', 'German'], ['sst', 'SST'], ['geo', 'Geography'],
  ['hist', 'History'], ['bio', 'Biology'],
];

/** Subject from a review folder slug ("chem_partnerb11" -> Chemistry). */
export function subjectOf(slug, overrides = {}) {
  if (overrides[slug]) return overrides[slug];
  const s = String(slug).toLowerCase();
  const hit = SUBJECT_PREFIXES.find(([prefix]) => s.startsWith(prefix));
  return hit ? hit[1] : slug;
}

const normLabel = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Join one student's independent grades with the pipeline's marks.
 * Returns one row per independently graded paper question. A pipeline question
 * claimed by several paper questions is a shared unit and is marked as such.
 */
export function joinPaper(grades, pipeline) {
  const byNorm = Object.fromEntries(pipeline.questions.map((q) => [normLabel(q.q), q.q]));
  const byQ = Object.fromEntries(pipeline.questions.map((q) => [q.q, q]));
  const questions = (grades.questions || []).map((q) => ({
    ...q,
    pipeline_q: (q.pipeline_q || []).map((x) => byNorm[normLabel(x)] || x).filter((x) => byQ[x]),
  }));
  const claims = {};
  for (const q of questions) for (const x of q.pipeline_q) claims[x] = (claims[x] || 0) + 1;
  return questions.map((q) => ({
    paperQ: q.paper_q,
    pipelineQ: q.pipeline_q,
    max: Number(q.max || 0),
    independent: Number(q.awarded || 0),
    pipeline: q.pipeline_q.reduce((sum, x) => sum + Number(byQ[x].ai || 0) / claims[x], 0),
    sharedUnit: q.pipeline_q.some((x) => claims[x] > 1),
  }));
}

/**
 * Build evaluation items for one test folder.
 * @param {object} input
 * @param {string} input.test      stable test key, e.g. "research2/chem_partnerb11"
 * @param {string} input.subject
 * @param {object} input.rubric    pipeline rubric ({exam, questions:[{number, ...}]})
 * @param {object} input.pipeline  HIDDEN_pipeline_marks.json contents
 * @param {object} input.grades    {studentN: grades.json}
 * @param {object[]} input.adjudications adjudication.json rows
 * @param {object} [input.rubricOverride] a rebuilt rubric to grade with instead. Its questions
 *   are matched to the pipeline's by folded number; ones that are missing or carry different
 *   marks are skipped, since the ground truth was set against the original question.
 * @returns {{items: object[], skipped: Record<string, number>}}
 */
export function buildTestItems({ test, subject, rubric, pipeline, grades, adjudications = [], rubricOverride = null }) {
  const fold = (value) => String(value || '').trim().toLowerCase().replace(/^q/, '').replace(/[()\s_.-]/g, '');
  const overrideByNumber = rubricOverride ? new Map((rubricOverride.questions || []).map((q) => [fold(q.number), q])) : null;
  const source = rubricOverride || rubric;
  const adj = new Map(adjudications.map((a) => [`${a.student}|${a.paper_q}`, a]));
  const items = [];
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  const instructions = `${source.exam?.instructions || ''} ${source.exam?.optional_rules || ''}`.trim();
  for (const [student, studentGrades] of Object.entries(grades)) {
    const marks = pipeline[student];
    if (!marks) { skip('no_pipeline_marks'); continue; }
    for (const row of joinPaper(studentGrades, marks)) {
      if (row.sharedUnit) { skip('shared_unit'); continue; }
      if (row.pipelineQ.length !== 1) { skip(row.pipelineQ.length ? 'multi_pipeline_q' : 'unmatched'); continue; }
      const a = adj.get(`${student}|${row.paperQ}`);
      const diff = Math.abs(row.pipeline - row.independent);
      let gt; let source;
      if (a) {
        if (a.correct_mark == null) { skip('adjudicated_without_mark'); continue; }
        gt = Number(a.correct_mark); source = 'adjudicated';
      } else if (diff < 0.01) {
        gt = row.pipeline; source = 'agreed';
      } else {
        skip(diff >= 1 ? 'unadjudicated_disagreement' : 'under_one_mark_apart');
        continue;
      }
      const number = row.pipelineQ[0];
      const original = (rubric.questions || []).find((q) => q.number === number);
      const pq = marks.questions.find((q) => q.q === number);
      if (!original || !pq) { skip('no_rubric_question'); continue; }
      let rq = original;
      if (overrideByNumber) {
        rq = overrideByNumber.get(fold(number));
        if (!rq) { skip('rebuilt_question_missing'); continue; }
        if (Math.abs(Number(rq.marks_allocated) - Number(original.marks_allocated)) > 0.01) { skip('rebuilt_marks_changed'); continue; }
      }
      const answer = String(pq.answer || '').trim();
      items.push({
        id: `${test}|${student}|${number}`,
        test,
        subject,
        type: rq.expected_response_type || '',
        max: Number(rq.marks_allocated || row.max),
        gt,
        gtSource: source,
        pipelineStored: Math.round(row.pipeline * 100) / 100,
        adjCause: a?.cause || null,
        adjStage: a?.stage || null,
        question: {
          question_number: number,
          question_text: rq.question_text,
          answer_key_text: rq.correct_answer_summary,
          ...(rq.mark_step ? { mark_step: rq.mark_step } : {}),
          marking_rubric: rq.marking_rubric,
          marks_total: rq.marks_allocated,
          expected_response_type: rq.expected_response_type,
          exam_instructions: instructions,
          test_subject: subject,
        },
        rubric: { expected_response_type: rq.expected_response_type, marking_rubric: rq.marking_rubric, accepted_variations: [] },
        evidence: { student_answer: answer, attempted: Boolean(answer), extraction_confidence: pq.lowConf ? 'low' : 'high' },
      });
    }
  }
  return { items, skipped };
}

const ratio = (num, den) => (den ? num / den : null);

function groupStats(rows) {
  const n = rows.length;
  return {
    n,
    exact: ratio(rows.filter((r) => Math.abs(r.err) < 0.01).length, n),
    within1: ratio(rows.filter((r) => Math.abs(r.err) < 1).length, n),
    meanSigned: ratio(rows.reduce((s, r) => s + r.err, 0), n),
  };
}

/** Deterministic PRNG so bootstrap intervals are reproducible run to run. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

/**
 * 95% interval for the within-one-mark rate, resampling whole tests, since answers
 * from one test share a rubric and are correlated.
 */
export function clusterBootstrapWithin1(rows, { reps = 2000, seed = 20261019 } = {}) {
  const clusters = Object.values(rows.reduce((m, r) => { (m[r.test] ||= []).push(r); return m; }, {}));
  if (clusters.length < 2) return null;
  const rand = lcg(seed);
  const stats = [];
  for (let b = 0; b < reps; b += 1) {
    let n = 0; let k = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const c = clusters[Math.floor(rand() * clusters.length)];
      n += c.length; k += c.filter((r) => Math.abs(r.err) < 1).length;
    }
    stats.push(k / n);
  }
  stats.sort((a, b) => a - b);
  return { lo: stats[Math.floor(0.025 * (reps - 1))], hi: stats[Math.ceil(0.975 * (reps - 1))] };
}

/**
 * Score a set of marks against the items' ground truth.
 * @param {object[]} items evaluation items
 * @param {Map<string, number>|Record<string, number>} marks mark per item id
 */
export function summarize(items, marks, options = {}) {
  const get = marks instanceof Map ? (id) => marks.get(id) : (id) => marks[id];
  const rows = items
    .filter((it) => Number.isFinite(Number(get(it.id))))
    .map((it) => ({ ...it, mark: Number(get(it.id)), err: Number(get(it.id)) - it.gt }));
  const bySubject = {};
  for (const subject of [...new Set(rows.map((r) => r.subject))].sort()) {
    const subjectRows = rows.filter((r) => r.subject === subject);
    bySubject[subject] = { ...groupStats(subjectRows), within1Ci: clusterBootstrapWithin1(subjectRows, options) };
  }
  const adjudicated = rows.filter((r) => r.gtSource === 'adjudicated');
  const marksMovedByCause = {};
  for (const r of adjudicated) {
    const cause = r.adjCause || 'unknown';
    const entry = (marksMovedByCause[cause] ||= { n: 0, stored: 0, run: 0 });
    entry.n += 1;
    entry.stored += Math.abs(r.pipelineStored - r.gt);
    entry.run += Math.abs(r.err);
  }
  return {
    ...groupStats(rows),
    within1Ci: clusterBootstrapWithin1(rows, options),
    coverage: { scored: rows.length, items: items.length },
    exactAdjudicated: { n: adjudicated.length, rate: ratio(adjudicated.filter((r) => Math.abs(r.err) < 0.01).length, adjudicated.length) },
    bySubject,
    marksMovedByCause,
  };
}

/**
 * Regression gate for a candidate run against a baseline on the same items:
 * no subject's within-one-mark rate may fall by more than maxDropPoints. The default of
 * 2 points sits above run-to-run noise: two runs of identical code moved a subject by up
 * to 1.1 points (2,103 questions, 2026-10-19). Subjects with
 * fewer than minQuestions scored questions are reported as ungated: one question there
 * moves the rate by several points, so a drop says nothing.
 */
export function gateAgainstBaseline(baseline, candidate, { maxDropPoints = 2, minQuestions = 50 } = {}) {
  const failures = [];
  const ungated = [];
  for (const [subject, base] of Object.entries(baseline.bySubject)) {
    const cand = candidate.bySubject[subject];
    if (!cand || base.within1 == null || cand.within1 == null) continue;
    if (base.n < minQuestions) { ungated.push(subject); continue; }
    const drop = (base.within1 - cand.within1) * 100;
    if (drop > maxDropPoints) failures.push({ subject, baseline: base.within1, candidate: cand.within1, dropPoints: Math.round(drop * 10) / 10 });
  }
  return { pass: failures.length === 0, failures, ungated };
}

/**
 * Gate against several baselines (e.g. two runs of today's code): a subject fails
 * only if it drops more than maxDropPoints below every one of them, so the gate
 * allows for the run-to-run noise the baselines themselves show. The reported
 * failure is the one against the lowest baseline.
 */
export function gateAgainstBaselines(baselines, candidate, options = {}) {
  const results = baselines.map((baseline) => gateAgainstBaseline(baseline, candidate, options));
  const failures = (results[0]?.failures || [])
    .map((first) => results.map((result) => result.failures.find((f) => f.subject === first.subject)))
    .filter((perBaseline) => perBaseline.every(Boolean))
    .map((perBaseline) => perBaseline.reduce((low, f) => (f.dropPoints < low.dropPoints ? f : low)));
  return { pass: failures.length === 0, failures, ungated: results[0]?.ungated || [] };
}

const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const signed = (value) => (value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(3)}`);
const ci = (value) => (value ? ` (${pct(value.lo)}–${pct(value.hi)})` : '');

/** Markdown report for one summary, optionally beside a baseline. */
export function formatReport(summary, { label = 'run', baseline = null, baselineLabel = 'baseline' } = {}) {
  const lines = [];
  lines.push(`Scored ${summary.coverage.scored} of ${summary.coverage.items} questions.`, '');
  lines.push(`| Measure | ${baseline ? `${baselineLabel} | ` : ''}${label} |`);
  lines.push(`|---|${baseline ? '---|' : ''}---|`);
  const row = (name, pick) => lines.push(`| ${name} | ${baseline ? `${pick(baseline)} | ` : ''}${pick(summary)} |`);
  row('Exact', (s) => pct(s.exact));
  row('Within one mark (|err| < 1)', (s) => `${pct(s.within1)}${ci(s.within1Ci)}`);
  row('Exact on adjudicated questions', (s) => `${pct(s.exactAdjudicated.rate)} of ${s.exactAdjudicated.n}`);
  row('Mean signed error (marks)', (s) => signed(s.meanSigned));
  lines.push('', `| Subject | n | ${baseline ? `${baselineLabel} within 1 | ` : ''}${label} within 1 | ${baseline ? 'change (points) | ' : ''}${label} exact | ${label} mean signed |`);
  lines.push(`|---|---|${baseline ? '---|' : ''}---|${baseline ? '---|' : ''}---|---|`);
  for (const [subject, s] of Object.entries(summary.bySubject)) {
    const b = baseline?.bySubject[subject];
    const change = b?.within1 != null && s.within1 != null ? `${s.within1 >= b.within1 ? '+' : ''}${((s.within1 - b.within1) * 100).toFixed(1)} | ` : '— | ';
    lines.push(`| ${subject} | ${s.n} | ${baseline ? `${pct(b?.within1)} | ` : ''}${pct(s.within1)}${ci(s.within1Ci)} | ${baseline ? change : ''}${pct(s.exact)} | ${signed(s.meanSigned)} |`);
  }
  lines.push('', '| Cause (adjudicated questions) | n | Marks moved, stored pipeline | Marks moved, this run |', '|---|---|---|---|');
  for (const [cause, m] of Object.entries(summary.marksMovedByCause).sort((a, b) => b[1].stored - a[1].stored)) {
    lines.push(`| ${cause} | ${m.n} | ${m.stored.toFixed(1)} | ${m.run.toFixed(1)} |`);
  }
  return lines.join('\n');
}
