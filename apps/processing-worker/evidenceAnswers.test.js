import { describe, it, expect } from 'vitest';
import { normalizeEvidenceAnswers, evidenceOutcome, answerPresenceCount } from './evidenceAnswers.js';
import { withSourcePages } from './sourcePages.js';

function rubricOf(n) {
  return { questions: Array.from({ length: n }, (_, i) => ({ number: String(i + 1), question_text: `Q${i + 1}`, marks_allocated: 1 })) };
}

describe('normalizeEvidenceAnswers — FLKRM-152', () => {
  it('a missing answer entry never grades 0: it becomes evidence_blocked (flagged), not a confident blank', () => {
    const rubric = rubricOf(10);
    // Model returned only 8 of 10 answers (truncated/chunk drop).
    const raw = { answers: Array.from({ length: 8 }, (_, i) => ({ question_number: String(i + 1), student_answer: `student text ${i + 1}`, attempted: true, confidence: 'high' })) };
    const answers = normalizeEvidenceAnswers(raw, rubric);

    const outcomes = answers.map(evidenceOutcome);
    const blocked = outcomes.filter((o) => o.status === 'evidence_blocked');
    const graded = outcomes.filter((o) => o.status === 'pending');

    // 2 missing -> blocked, 8 present -> graded. NOT 10 graded.
    expect(blocked.length).toBe(2);
    expect(graded.length).toBe(8);
    blocked.forEach((o, i) => {
      expect(o.status).toBe('evidence_blocked');
      expect(o.flagged).toBe(true);
      expect(o.reviewPriority).toBe('flagged');
    });
  });

  it('a truncated response is detectable via presence count (drives the retry)', () => {
    const rubric = rubricOf(10);
    const raw = { answers: Array.from({ length: 8 }, (_, i) => ({ question_number: String(i + 1) })) };
    expect(answerPresenceCount(raw, rubric)).toBe(8);
    expect(answerPresenceCount({ answers: [] }, rubric)).toBe(0);
    expect(answerPresenceCount(raw, rubric)).toBeLessThan(rubric.questions.length);
  });

  it("attempted is NOT inferred from text presence when confidence is low", () => {
    const rubric = rubricOf(1);
    // Model gives a low-confidence answer (e.g. keyword bleed from adjacent Q).
    const raw = { answers: [{ question_number: '1', student_answer: 'some bleed text', attempted: false, confidence: 'low' }] };
    const [answer] = normalizeEvidenceAnswers(raw, rubric);
    expect(answer.attempted).toBe(false);
    expect(answer.confidence).toBe('low');
    const outcome = evidenceOutcome(answer);
    // Has text, so it is not an evidence-capture failure (not blocked); but it is
    // explicitly not attempted -> not_attempted, and low confidence -> flagged,
    // so it is never graded as a confident answer.
    expect(outcome.flagged).toBe(true);
    expect(outcome.status).toBe('not_attempted');
  });

  it("an attempted:true entry with NO text and NO source pages is still blocked (not a confident 0)", () => {
    const rubric = rubricOf(1);
    // Truncated JSON still emits attempted:true with an empty student_answer.
    const raw = { answers: [{ question_number: '1', student_answer: '', attempted: true, confidence: 'low' }] };
    const [answer] = normalizeEvidenceAnswers(raw, rubric);
    expect(answer.attempted).toBe(true);
    const outcome = evidenceOutcome(answer);
    // No usable gradeable evidence (no text, no source pages) -> blocked, even
    // though attempted:true. Without this, such an entry would grade 0.
    expect(outcome.blocked).toBe(true);
    expect(outcome.status).toBe('evidence_blocked');
    expect(outcome.flagged).toBe(true);
  });

  it("a confident-but-empty entry (attempted:true, no text, no pages, high confidence) is still blocked", () => {
    const rubric = rubricOf(1);
    // Anomalous but possible: model reports high confidence with no text and no
    // source pages. There is still nothing to grade -> block & flag, never a
    // silent 0 (regardless of confidence).
    const raw = { answers: [{ question_number: '1', student_answer: '', attempted: true, confidence: 'high' }] };
    const [answer] = normalizeEvidenceAnswers(raw, rubric);
    expect(answer.confidence).toBe('high');
    const outcome = evidenceOutcome(answer);
    expect(outcome.blocked).toBe(true);
    expect(outcome.status).toBe('evidence_blocked');
    expect(outcome.flagged).toBe(true);
  });

  it('keeps confident (medium/high) answers as attempted and pending, not blocked', () => {
    const rubric = rubricOf(2);
    const raw = {
      answers: [
        { question_number: '1', student_answer: 'answer one', attempted: true, confidence: 'high' },
        // No attempted flag at all: medium confidence + text -> inferred attempted.
        { question_number: '2', student_answer: 'answer two', confidence: 'medium' },
      ],
    };
    const answers = normalizeEvidenceAnswers(raw, rubric);
    expect(answers[0].attempted).toBe(true);
    expect(evidenceOutcome(answers[0]).status).toBe('pending');
    // Medium confidence with text but no attempted flag: inferred attempted, not blocked.
    expect(answers[1].attempted).toBe(true);
    expect(evidenceOutcome(answers[1]).status).toBe('pending');
  });

  it("honors an explicit attempted:false at medium confidence with leftover text (no inference)", () => {
    const rubric = rubricOf(1);
    // Model says attempted:false but leftover OCR text exists at medium confidence.
    // Inferring attempted=true here is the old keyword-bleed -> graded bug. Honor false.
    const raw = { answers: [{ question_number: '1', student_answer: 'leftover bleed text', attempted: false, confidence: 'medium' }] };
    const [answer] = normalizeEvidenceAnswers(raw, rubric);
    expect(answer).toMatchObject({ attempted: false, confidence: 'medium' });
    const outcome = evidenceOutcome(answer);
    // Has text, so not blocked; but explicitly not attempted -> not_attempted, never graded.
    expect(outcome.status).toBe('not_attempted');
  });

  it('a genuine blank (explicit low confidence, no text, no source pages) is flagged, not silently zeroed', () => {
    const rubric = rubricOf(1);
    const raw = { answers: [{ question_number: '1', student_answer: '', attempted: false, confidence: 'low' }] };
    const [answer] = normalizeEvidenceAnswers(raw, rubric);
    const outcome = evidenceOutcome(answer);
    expect(outcome.status).toBe('evidence_blocked');
    expect(outcome.flagged).toBe(true);
  });
});

describe('evidenceOutcome — OCR input incomplete', () => {
  // The extraction model echoes the schema example source_pages:[0] even for
  // blanks, so a confident blank normally passes the no-evidence check.
  const confidentBlank = () => normalizeEvidenceAnswers(
    { answers: [{ question_number: '1', attempted: false, student_answer: '', source_pages: [0], confidence: 'high' }] },
    rubricOf(1),
  )[0];

  it('without the flag, a confident blank with source_pages [0] stays not_attempted (current behavior)', () => {
    const outcome = evidenceOutcome(confidentBlank());
    expect(outcome.blocked).toBe(false);
    expect(outcome.status).toBe('not_attempted');
  });

  it('when pages were clipped or dropped, a blank is blocked and flagged, never graded 0', () => {
    const outcome = evidenceOutcome(confidentBlank(), { ocrIncomplete: true });
    expect(outcome.blocked).toBe(true);
    expect(outcome.status).toBe('evidence_blocked');
    expect(outcome.flagged).toBe(true);
  });

  it('an extracted answer is still graded when OCR was incomplete', () => {
    const [answer] = normalizeEvidenceAnswers(
      { answers: [{ question_number: '1', attempted: true, student_answer: 'Silicon = 14', source_pages: [2], confidence: 'high' }] },
      rubricOf(1),
    );
    const outcome = evidenceOutcome(answer, { ocrIncomplete: true });
    expect(outcome.blocked).toBe(false);
    expect(outcome.status).toBe('pending');
  });
});


describe('evidenceOutcome after withSourcePages (#343)', () => {
  // The worker's real order: normalize the model's answers, replace their pages
  // with text matches against the sheet, then decide the outcome. A blank never
  // text-matches, so its sourcePages is always [] by the time it is decided.
  const sheet = [
    'Q1 Silicon has atomic number 14',
    'Q2 Photosynthesis needs sunlight and water',
  ];
  const decide = (modelAnswers, options) => withSourcePages(
    normalizeEvidenceAnswers({ answers: modelAnswers }, rubricOf(3)),
    sheet,
  ).map((answer) => ({ answer, outcome: evidenceOutcome(answer, options) }));
  const skipped = (number, confidence) => ({ question_number: number, attempted: false, student_answer: '', source_pages: [0], confidence });
  const written = (number, answer) => ({ question_number: number, attempted: true, student_answer: answer, source_pages: [0], confidence: 'high' });

  it('a confident explicit not-attempted entry is not_attempted (0), not blocked', () => {
    const [, , high] = decide([written('1', 'Silicon has atomic number 14'), written('2', 'Photosynthesis needs sunlight'), skipped('3', 'high')]);
    expect(high.answer.sourcePages).toEqual([]);
    expect(high.outcome).toMatchObject({ blocked: false, status: 'not_attempted', flagged: false });
    const [, , medium] = decide([written('1', 'Silicon has atomic number 14'), written('2', 'Photosynthesis needs sunlight'), skipped('3', 'medium')]);
    expect(medium.outcome).toMatchObject({ blocked: false, status: 'not_attempted', flagged: false });
  });

  it('a missing model entry is blocked', () => {
    const [, , missing] = decide([written('1', 'Silicon has atomic number 14'), written('2', 'Photosynthesis needs sunlight')]);
    expect(missing.outcome).toMatchObject({ blocked: true, status: 'evidence_blocked', flagged: true });
  });

  it('a low-confidence not-attempted entry is blocked', () => {
    const [, , low] = decide([written('1', 'Silicon has atomic number 14'), written('2', 'Photosynthesis needs sunlight'), skipped('3', 'low')]);
    expect(low.outcome).toMatchObject({ blocked: true, status: 'evidence_blocked', flagged: true });
  });

  it('a confident not-attempted entry is blocked when OCR was incomplete', () => {
    const [, , blank] = decide([written('1', 'Silicon has atomic number 14'), written('2', 'Photosynthesis needs sunlight'), skipped('3', 'high')], { ocrIncomplete: true });
    expect(blank.outcome).toMatchObject({ blocked: true, status: 'evidence_blocked' });
  });

  it('an all-MCQ parse miss (worker placeholder, no page claim) stays blocked', () => {
    const [, , miss] = decide([written('1', 'Silicon has atomic number 14'), written('2', 'Photosynthesis needs sunlight'), { question_number: '3', attempted: false, student_answer: '', source_pages: [], confidence: 'medium' }]);
    expect(miss.outcome).toMatchObject({ blocked: true, status: 'evidence_blocked' });
  });

  it('an attempted answer is graded with the page its text was found on', () => {
    const [first, second] = decide([written('1', 'Silicon has atomic number 14'), written('2', 'Photosynthesis needs sunlight'), skipped('3', 'high')]);
    expect(first.answer.sourcePages).toEqual([1]);
    expect(second.answer.sourcePages).toEqual([2]);
    expect(first.outcome).toMatchObject({ blocked: false, status: 'pending', flagged: false });
    expect(second.outcome).toMatchObject({ blocked: false, status: 'pending', flagged: false });
  });
});
