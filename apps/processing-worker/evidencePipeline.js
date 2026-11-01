/**
 * Adaptive Evidence Extraction Pipeline
 *
 * Handles papers of any size (20-80+ marks) by:
 * 1. Classifying the exam (size, types, numbering format)
 * 2. Cleaning OCR text (rule-based, free)
 * 3. Chunking questions by section for focused extraction
 * 4. Adaptive reasoning effort per chunk type
 */

// ─── OCR Text Cleaning ────────────────────────────────────────────────────────

/**
 * Rule-based OCR noise removal. Generalizes across exam formats:
 * - Converts inline HTML tables to plain text
 * - Strips empty table cells (pipes with nothing between them)
 * - Removes repeated page headers (Q.No., प्र.क्र., etc.)
 * - Removes lone page numbers
 * - Collapses excessive whitespace
 */
export function cleanOcrText(raw, { preserveMarkers = false } = {}) {
  if (!raw) return '';
  const HEADER_PATTERNS = /^(Q\.?No\.?|प्र\.?क्र\.?|No\.?|A\.?P\.?|Q\.?No\.?\s*)$/i;
  // Matches lines composed entirely of header fragments (e.g., "A.P. Q.No.", "प्र.क्र. Q.No.", "5. No.")
  const HEADER_LINE = /^([\d.\s]|Q\.?No\.?|प्र\.?क्र\.?|A\.?P\.?|No\.?)+$/i;
  // Strike-through tags become ~~…~~ first, so table flattening (which drops every
  // tag) keeps them and the answer normaliser can move them to crossed_out_work.
  // First: convert any inline HTML tables to plain text
  let text = String(raw).replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, (match, tag, inner) => (inner.trim() ? `~~${inner.trim()}~~` : ''));
  text = text.replace(/<table[\s\S]*?<\/table>/gi, (html) => htmlTableToPlainText(html));
  // Printed booklet page numbers go; a bare number anywhere else may be a final answer ("120").
  text = dropBookletPageNumbers(text);
  // Strip asset labels, unresolved table refs, empty table markers, and page markers
  text = text
    .replace(/\[asset:[^\]]*\]/g, '')
    .replace(/\[tbl-\d+\.html\]\(tbl-\d+\.html\)/g, '')
    .replace(/^\[table \d+\]\s*$/gm, '')
    .replace(/^--- page \d+ ---$/gm, '');
  // Strip section headers (Q1, Q2., etc.) — they are UNRELIABLE in student answer sheets.
  // Students often write the wrong section number. Content matching is the only safe strategy.
  // NOTE: In marker mode (math/physics) these Q-markers are the PRIMARY disambiguator, so they
  // must be preserved — the marker-based prompt relies on them to locate each answer.
  if (!preserveMarkers) {
    text = text.replace(/^\s*Q\d+\.?\s*$/gm, '');
  }
  return text
    .split('\n')
    .map((line) => {
      if (line.includes('|')) {
        const cells = line.split('|')
          .map((c) => c.trim())
          .filter((c) => c && !HEADER_PATTERNS.test(c) && (preserveMarkers || !/^Q\d+\.?$/.test(c)));
        // Join pipe-separated cells as natural text (they represent columns or sub-items)
        return cells.join(' — ');
      }
      return line.trim();
    })
    .filter((line) => {
      if (!line) return false;
      if (HEADER_PATTERNS.test(line)) return false;
      // Header fragments only; a line of just digits and dots ("120", "3.14") is kept as a possible answer.
      if (HEADER_LINE.test(line) && /[^\d.\s]/.test(line)) return false;
      // Remove lines that are just a number followed by a dot (bare sub-question markers with no content)
      if (/^\d+\.\s*$/.test(line)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const PAGE_SECTION_BREAK = /^(?:\[asset:[^\]]*\]|--- page \d+ ---)$/;
const PAGE_NUMBER_LINE = /^[-–(]?\s*(?:page\s*)?(\d{1,3})\s*[-–)]?$/i;

/**
 * Removes printed answer-booklet page numbers: a bare number on the first or
 * last line of a page that continues the numbering of a neighbouring page
 * (2 then 3). A bare number with no such neighbour is left alone, since it may
 * be a student's final answer that happens to end a page.
 */
export function dropBookletPageNumbers(text) {
  const lines = String(text || '').split('\n');
  const sections = [];
  let start = 0;
  lines.forEach((line, index) => {
    if (PAGE_SECTION_BREAK.test(line.trim())) { sections.push([start, index]); start = index + 1; }
  });
  sections.push([start, lines.length]);
  const edges = sections.map(([from, to]) => {
    const content = [];
    for (let i = from; i < to; i += 1) if (lines[i].trim()) content.push(i);
    if (content.length < 2) return [];
    return [...new Set([content[0], content[content.length - 1]])]
      .map((index) => ({ index, value: Number(PAGE_NUMBER_LINE.exec(lines[index].trim())?.[1]) }))
      .filter((edge) => Number.isFinite(edge.value));
  });
  const drop = new Set();
  edges.forEach((page, p) => {
    for (const edge of page) {
      const continues = (edges[p - 1] || []).some((prev) => prev.value === edge.value - 1)
        || (edges[p + 1] || []).some((next) => next.value === edge.value + 1);
      if (continues) drop.add(edge.index);
    }
  });
  return drop.size ? lines.filter((_, index) => !drop.has(index)).join('\n') : lines.join('\n');
}

/** Convert an HTML table to plain text preserving row/cell structure. */
function htmlTableToPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\| \n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Clean and merge multiple OCR pages into a single text block.
 * Labels each page for source tracking.
 */
export function cleanAndMergePages(pages, opts = {}) {
  return pages
    .map((page, i) => {
      const clean = cleanOcrText(page.markdown || '', opts);
      if (!clean) return null;
      return `[page ${i + 1}]\n${clean}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

// ─── Exam Classification ──────────────────────────────────────────────────────

/**
 * Detect numbering format from question numbers.
 * Returns: 'flat' (1,2,3), 'dotted' (1.1, 1.2), 'compound' (Q1(2)(II)), 'sectioned' (Q1.A(1))
 */
export function detectNumberingFormat(questions) {
  const nums = questions.map((q) => q.number || q.question_number || '');
  if (nums.some((n) => /\(\d+\)\s*\([IVX]+\)/i.test(n))) return 'compound';
  if (nums.some((n) => /\.\s*[A-Z]\s*\(/i.test(n))) return 'sectioned';
  if (nums.some((n) => /^\d+\.\d+$/.test(n))) return 'dotted';
  return 'flat';
}

/**
 * Classify question types from the rubric.
 * Returns per-question type: 'mcq', 'short', 'long'
 */
export function classifyQuestionType(question) {
  const type = (question.expected_response_type || question.response_type || '').toLowerCase();
  if (type.includes('mcq') || type.includes('objective') || type.includes('multiple')) return 'mcq';
  // Honor an explicit written type. 1-mark "join the sentences" / fill-in items
  // are not MCQs; treating them as MCQ made Teil A/B headers become the answer.
  if (type.includes('long') || type.includes('essay') || type.includes('proof')) return 'long';
  if (type.includes('short') || type.includes('numerical') || type.includes('fill')
    || type.includes('diagram') || type.includes('table') || type.includes('other')) {
    const allocated = Number(question.marks_allocated || question.marks_total || 0);
    return allocated > 3 ? 'long' : 'short';
  }
  const marks = Number(question.marks_allocated || question.marks_total || 0);
  if (!marks) return 'short'; // unknown marks → default to short
  if (marks <= 1) return 'mcq';
  if (marks <= 3) return 'short';
  return 'long';
}

/**
 * Classify the overall exam for pipeline strategy.
 */
export function classifyExam(questions) {
  const count = questions.length;
  const format = detectNumberingFormat(questions);
  const types = questions.map(classifyQuestionType);
  const mcqCount = types.filter((t) => t === 'mcq').length;
  const longCount = types.filter((t) => t === 'long').length;
  const allMcq = count > 0 && mcqCount === count;

  let size = 'small';
  if (count > 25) size = 'large';
  else if (count > 12) size = 'medium';

  return { count, format, size, mcqCount, longCount, types, allMcq };
}

/**
 * Deterministic MCQ option extraction from answer-sheet OCR.
 * These sheets are usually "1] A / Q3 Ans) (D)" — keyword matching fails because
 * there are no content keywords, only numbers + letters.
 *
 * Returns Map<canonicalQuestionNumber, { letter, raw, confidence }>
 * keyed like "Q1" / "Q14" when possible.
 */
export function parseMcqAnswersFromOcr(ocrText = '', questionNumbers = []) {
  const text = String(ocrText || '');
  const canonical = questionNumbers.map((n) => {
    const raw = String(n || '').trim();
    const digits = raw.replace(/^Q/i, '');
    return { raw: raw.startsWith('Q') || raw.startsWith('q') ? `Q${digits}` : raw, digits: String(Number(digits) || digits) };
  });
  const byDigits = new Map();

  function setHit(digits, letter, raw, confidence = 'high') {
    const key = String(Number(digits));
    const opt = String(letter || '').toUpperCase();
    if (!key || !/[A-D]/.test(opt)) return;
    if (byDigits.has(key)) return;
    byDigits.set(key, { letter: opt, raw: String(raw || '').trim().slice(0, 40), confidence });
  }

  // Line-oriented pass handles two-column lists and "Q3 / Ans) (A)" pairs.
  let pendingQ = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const sameLine = trimmed.match(/^\(?\s*(?:Q\.?\s*)?(\d{1,2})\s*[\]\)\.\-:]\s*\(?\s*([A-Da-d])\s*\)?\.?\s*$/i);
    if (sameLine) {
      setHit(sameLine[1], sameLine[2], trimmed);
      pendingQ = null;
      continue;
    }

    const qOnly = trimmed.match(/^\(?\s*(?:Q\.?\s*)?(\d{1,2})\s*[\]\)\.\-:]?\s*$/i);
    if (qOnly) {
      pendingQ = qOnly[1];
      continue;
    }

    const ansOnly = trimmed.match(/^(?:Ans\]?\)?|Answer)?\s*[:=\-]?\s*\(?\s*([A-Da-d])\s*\)?\.?\s*$/i);
    if (pendingQ && ansOnly && /[A-Da-d]/.test(ansOnly[1])) {
      setHit(pendingQ, ansOnly[1], trimmed);
      pendingQ = null;
      continue;
    }

    // "Ans) (A)" / "Ans] A" after a pending question number
    const ansLabeled = trimmed.match(/^(?:Ans\]?\)?|Answer)\s*[:=\-]?\s*\(?\s*([A-Da-d])\s*\)?\.?\s*$/i);
    if (pendingQ && ansLabeled) {
      setHit(pendingQ, ansLabeled[1], trimmed);
      pendingQ = null;
    }
  }

  // Global sweep for inline forms the line parser misses, e.g. mid-paragraph "(14) (D)".
  const inline = /(?:^|[\s\(\[])(?:Q\.?\s*)?(\d{1,2})\s*[\]\)\.\-:]\s*\(?\s*([A-Da-d])\s*\)?\.?/gim;
  let match;
  while ((match = inline.exec(text))) {
    setHit(match[1], match[2], match[0], 'medium');
  }

  const out = new Map();
  if (canonical.length) {
    for (const item of canonical) {
      const hit = byDigits.get(item.digits);
      if (!hit) continue;
      out.set(item.raw.startsWith('Q') ? item.raw : `Q${item.digits}`, hit);
      out.set(item.digits, hit);
    }
  } else {
    for (const [digits, hit] of byDigits) {
      out.set(`Q${digits}`, hit);
      out.set(digits, hit);
    }
  }
  return out;
}

/**
 * Numbered written answers ("1) Ich bleibe…", "7. Ich glaube, dass…").
 * Used to recover sentence-length answers that MCQ extraction collapsed to
 * a Teil A/B section letter.
 */
export function parseNumberedWrittenAnswersFromOcr(ocrText = '') {
  const byDigits = new Map();
  const circled = /[\u2460-\u246B]/g;
  let pendingContinuation = null;
  for (const rawLine of String(ocrText || '').split(/\r?\n/)) {
    let rest = rawLine.trim().replace(/^[-*]\s*/, '');
    if (!rest) continue;
    rest = rest.replace(/[\u2460-\u2473]{2,}/g, (seq) => {
      const joined = [...seq].map((ch) => ch.codePointAt(0) - 0x2460 + 1).join('');
      return `${Number(joined)}) `;
    });
    rest = rest.replace(circled, (ch) => `${ch.codePointAt(0) - 0x2460 + 1}) `);
    rest = rest.replace(/~~[^~]*~~/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    rest = rest.replace(/^[A-D]\.\s+/i, '');
    const prefixes = [];
    const prefix = /^(?:Q\.?\s*)?(\d{1,2})\s*[).:\-\]]\s*/i;
    let match;
    while ((match = rest.match(prefix))) {
      prefixes.push(String(Number(match[1])));
      rest = rest.slice(match[0].length).trim();
    }
    if (!rest || /^[A-Da-d]$/.test(rest)) {
      pendingContinuation = prefixes[prefixes.length - 1] || pendingContinuation;
      continue;
    }
    if (!prefixes.length && pendingContinuation) {
      const next = String(Number(pendingContinuation) + 1);
      if (!byDigits.has(next) && Number(next) >= 1 && Number(next) <= 12) {
        byDigits.set(next, rest);
        pendingContinuation = next;
      }
      continue;
    }
    const question = prefixes[prefixes.length - 1];
    if (!question) continue;
    const previous = byDigits.get(question);
    if (!previous || rest.length > previous.length) byDigits.set(question, rest);
    pendingContinuation = question;
  }
  return byDigits;
}

const squash = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Repairs written answers that extraction collapsed to a section letter (German
// "Teil A/B"). Only a lone-letter answer to a non-MCQ question is replaced: a
// blank stays blank (a numbered sub-point such as "3)" inside Q1's answer must
// not become Q3's answer), an MCQ letter is the real answer, and text that
// already belongs to another question's answer is never reused.
export function overlayLetterOnlyAnswersFromNumberedOcr(answers, ocrText) {
  const written = parseNumberedWrittenAnswersFromOcr(ocrText);
  if (!written.size) return answers;
  return answers.map((answer) => {
    const digits = String(Number(String(answer.question?.number || answer.question_number || '').replace(/^Q/i, '')));
    const body = written.get(digits);
    if (!body) return answer;
    const current = String(answer.studentAnswer || '').trim();
    if (!/^[A-D]$/i.test(current)) return answer;
    if (String(answer.question?.expected_response_type || '').toLowerCase() === 'mcq') return answer;
    const needle = squash(body);
    const elsewhere = answers.some((other) => other !== answer && needle.length >= 8 && squash(other.studentAnswer).includes(needle));
    if (elsewhere) return answer;
    return {
      ...answer,
      studentAnswer: body,
      attempted: true,
      confidence: 'high',
    };
  });
}

/**
 * MCQ-only extraction prompt: match by question number / option letter,
 * NOT by science keywords (those do not appear on MCQ option sheets).
 */
export function buildMcqExtractionPrompt(chunk, ocrText) {
  const questionList = chunk.questions.map((q) => ({
    number: q.number || q.question_number,
    text: (q.question_text || '').slice(0, 120),
    marks: q.marks_allocated || q.marks_total || 0,
  }));
  return `You are extracting MCQ option letters from a student's answer sheet OCR.

This is an ALL-MCQ paper. Students write only question numbers and option letters
(e.g. "1] A", "(14) (D)", "Q3 Ans) (B)", two-column lists). There are usually NO
science keywords on the sheet.

METHOD:
1. For each canonical question number, find that number in the OCR (Q14, 14], 14), 14.)
2. Read the option letter next to it (A/B/C/D), including forms like "(D)", "D.", "Ans) (A)"
3. If the number is present but no letter → attempted=false
4. If the number is absent → attempted=false
5. Do NOT ignore question numbers. Numbers are the primary matcher for MCQ sheets.
6. Copy the selected letter into student_answer (just "A"/"B"/"C"/"D" is fine)

CANONICAL QUESTIONS:
${JSON.stringify(questionList)}

STUDENT ANSWER SHEET OCR:
${ocrText}

Return JSON only: {"answers":[{"question_number":"","attempted":false,"student_answer":"","crossed_out_work":"","source_pages":[0],"confidence":"low|medium|high","needs_visual_rescue":false,"visual_reason":""}]}`;
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Detect section boundaries from question numbers.
 * E.g., [1.1, 1.2, 2.1, 2.2, 3.1] → sections {1: [1.1,1.2], 2: [2.1,2.2], 3: [3.1]}
 */
export function detectSections(questions) {
  const sections = new Map();
  for (const q of questions) {
    const num = q.number || q.question_number || '';
    const secMatch = num.match(/^(\d+)/);
    const sec = secMatch ? secMatch[1] : '0';
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec).push(q);
  }
  return sections;
}

/** Hard cap — large flat papers (31+ Q in one section) truncate JSON mid-string. */
const MAX_QUESTIONS_PER_EVIDENCE_CHUNK = 12;

function pushQuestionSlices(chunks, questions, label) {
  for (let index = 0; index < questions.length; index += MAX_QUESTIONS_PER_EVIDENCE_CHUNK) {
    const slice = questions.slice(index, index + MAX_QUESTIONS_PER_EVIDENCE_CHUNK);
    const from = index + 1;
    const to = index + slice.length;
    const sliceLabel = questions.length > MAX_QUESTIONS_PER_EVIDENCE_CHUNK
      ? `${label}_${from}-${to}`
      : label;
    chunks.push({ questions: slice, label: sliceLabel });
  }
}

/**
 * Split questions into chunks for processing.
 * Cap at ~12 questions per LLM call so JSON output does not truncate
 * (flat 30+Q papers previously ran as one chunk and failed parse).
 */
export function chunkQuestions(questions) {
  if (questions.length <= MAX_QUESTIONS_PER_EVIDENCE_CHUNK) {
    return [{ questions, label: 'all' }];
  }

  const sections = detectSections(questions);
  const chunks = [];
  let current = [];
  let currentLabel = '';

  for (const [sec, qs] of sections) {
    if (qs.length > MAX_QUESTIONS_PER_EVIDENCE_CHUNK && current.length === 0) {
      pushQuestionSlices(chunks, qs, `Q${sec}`);
      continue;
    }
    if (current.length + qs.length > MAX_QUESTIONS_PER_EVIDENCE_CHUNK && current.length > 0) {
      pushQuestionSlices(chunks, current, currentLabel);
      current = [];
      currentLabel = '';
    }
    if (qs.length > MAX_QUESTIONS_PER_EVIDENCE_CHUNK) {
      pushQuestionSlices(chunks, qs, `Q${sec}`);
      continue;
    }
    current.push(...qs);
    currentLabel = currentLabel ? `${currentLabel}+Q${sec}` : `Q${sec}`;
  }
  if (current.length) pushQuestionSlices(chunks, current, currentLabel || 'all');
  return chunks;
}

// ─── Math Detection ───────────────────────────────────────────────────────────

/**
 * Detect if an exam is math-heavy (trigonometry, calculus, algebra, etc.)
 * Math exams have symbols that appear in every question, making keyword matching unreliable.
 */
export function isMathHeavyExam(questions) {
  const mathKeywords = [
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
    'log', 'ln', 'lim', 'diff', 'integr',
    'matrix', 'determinant', 'vector',
    'derivative', 'integral', 'differentiat',
    '∫', '∑', '√', 'π', 'θ', 'α', 'β', 'γ', 'δ',
    'sin⁻¹', 'cos⁻¹', 'tan⁻¹',
  ];
  const mathPattern = new RegExp(mathKeywords.join('|'), 'i');
  const questionTexts = questions.map((q) => (q.question_text || q.text || '').toLowerCase());
  const mathQuestionCount = questionTexts.filter((text) => mathPattern.test(text)).length;
  // If more than 50% of questions contain math symbols, it's math-heavy
  return mathQuestionCount / questions.length > 0.5;
}

/**
 * Subjects where content keywords repeat across nearly every question, so
 * keyword matching cannot distinguish answers. These MUST use marker-based
 * (or bbox-based) extraction regardless of keyword density in the question text.
 */
const MARKER_SUBJECT_PATTERNS = [
  /math/i, /mathematics/i, /applied\s*math/i, /pure\s*math/i, /further\s*math/i,
  /maths/i, /arithmetic/i, /algebra/i, /geometry/i, /trigono/i, /calculus/i,
  /physics/i, /applied\s*physics/i, /mechanics/i,
];

/** True when the exam subject requires marker-based extraction, never keyword-only. */
export function isMarkerSubject(subject) {
  if (!subject) return false;
  return MARKER_SUBJECT_PATTERNS.some((pattern) => pattern.test(String(subject)));
}

/**
 * Decide whether to use marker-based (trust student Q-markers) extraction.
 * - MCQ papers are handled separately by number/letter matching — not markers.
 * - Math/physics subjects always use markers (issue FLKRM-156).
 * - Otherwise fall back to keyword-density (math-heavy) detection for unknown subjects.
 */
export function shouldUseMarkers(questions, subject) {
  if (!Array.isArray(questions) || questions.length === 0) return false;
  const types = questions.map(classifyQuestionType);
  if (types.length > 0 && types.every((t) => t === 'mcq')) return false;
  if (isMarkerSubject(subject)) return true;
  return isMathHeavyExam(questions);
}

// ─── Prompt Building ──────────────────────────────────────────────────────────

/**
 * Generate a numbering hint based on detected format.
 */
export function buildNumberingHint(format) {
  switch (format) {
    case 'dotted':
      return `NUMBERING: Questions use "section.sub" format (e.g., 3.4 = section 3, sub-question 4). Students write sub-numbers (1, 2, 3...) that may appear under section headers — but section headers written by students are OFTEN WRONG. NEVER trust section headers. Match ONLY by content keywords.`;
    case 'compound':
      return `NUMBERING: Questions use compound format like "Q1 (2)(II)". Match ONLY by content keywords, not by numbering.`;
    case 'sectioned':
      return `NUMBERING: Questions use format like "Q1.A(1)". Match ONLY by content keywords, not by numbering.`;
    default:
      return `NUMBERING: Match ONLY by content keywords. Ignore all section headers and numbering in the OCR.`;
  }
}

/**
 * Build extraction prompt for math-heavy exams.
 * Uses student-written question markers instead of keyword matching.
 */
function buildMathExtractionPrompt(chunk, ocrText) {
  const questionList = chunk.questions.map((q) => ({
    number: q.number || q.question_number,
    text: (q.question_text || '').slice(0, 200),
    marks: q.marks_allocated || q.marks_total || 0,
  }));

  return `You are mapping a student's handwritten MATH answer sheet (OCR text) to canonical exam questions.

MATH-SPECIFIC INSTRUCTIONS:
- Students write question markers like "Q1]", "Q:-2]", "Q 3]", "Q.4)", "Q5:" etc.
- These markers are RELIABLE for math exams — USE them to locate answers
- Sub-questions may be marked as "1]", "i]", "(a)", "(i)" under a main question
- Math answers contain symbols (sin, cos, tan, √, π, ∫, ∑, fractions, equations)
- Extract the COMPLETE mathematical work the student wrote (formulas, steps, and any concluding line they actually wrote)

METHOD:
1. For each canonical question number (e.g., "Q1.i", "Q5", "Q10"):
   a. Look for student markers matching that number: "Q1", "Q 1]", "Q:-1]", "1]", "1)" etc.
   b. Extract ALL text following that marker until the next question marker
   c. Include all mathematical work they wrote: formulas, substitutions, concluding line if present
2. If no marker found for a question, search nearby text for matching math content
3. If still not found, mark as not attempted

RULES:
- TRUST student question markers for math exams (unlike other subjects)
- An answer may span multiple lines or continue after a page break
- Do NOT infer an answer from the question text itself
- Extract mathematical expressions exactly as written (preserve LaTeX if present)
- Copy OCR text VERBATIM into student_answer. Do NOT complete unfinished work, correct chemistry/math, polish wording, or invent a boxed/final conclusion. If the student left an incomplete reaction or equation, keep it incomplete.
- Put struck-through OCR into crossed_out_work only when clearly crossed out; otherwise leave it empty
- Keep every [unread region] marker exactly where it appears in the student's answer: it is handwriting the OCR could not read. Never drop it or guess what it says
- Set needs_visual_rescue=true only when the answer depends on a diagram/graph/image

CANONICAL QUESTIONS:
${JSON.stringify(questionList)}

STUDENT ANSWER SHEET OCR:
${ocrText}

Return JSON only: {"answers":[{"question_number":"","attempted":false,"student_answer":"","crossed_out_work":"","source_pages":[0],"confidence":"low|medium|high","needs_visual_rescue":false,"visual_reason":""}]}`;
}

/**
 * Build the extraction prompt for a chunk of questions.
 */
export function buildExtractionPrompt(chunk, ocrText, classification, subject) {
  const { format, allMcq } = classification;
  const types = (chunk.questions || []).map(classifyQuestionType);
  const chunkAllMcq = types.length > 0 && types.every((t) => t === 'mcq');

  // All-MCQ sheets are option lists — never use keyword matching.
  if (allMcq || chunkAllMcq) {
    return buildMcqExtractionPrompt(chunk, ocrText);
  }

  // Use marker-based (math) prompt when subject requires it (math/physics) or the
  // paper is math-heavy. Keyword matching is unreliable where symbols repeat.
  if (shouldUseMarkers(chunk.questions, subject)) {
    return buildMathExtractionPrompt(chunk, ocrText);
  }

  // Standard keyword-based prompt for other subjects
  const numberingHint = buildNumberingHint(format);
  const questionList = chunk.questions.map((q) => ({
    number: q.number || q.question_number,
    text: (q.question_text || '').slice(0, 150),
    marks: q.marks_allocated || q.marks_total || 0,
    type: q.expected_response_type || null,
    visual: q.visual_requirements || null,
  }));

  return `You are mapping a student's handwritten answer sheet (OCR text) to canonical exam questions.

${numberingHint}

CRITICAL METHOD — follow this for EVERY question:
1. Read the question text and identify 2-3 KEYWORDS (e.g., "Lenz's law", "eddy current", "self inductance")
2. SEARCH the entire OCR text for those keywords or close variants (OCR may add apostrophes/typos: "Len'z's" = "Lenz's")
3. If found → extract the FULL student answer around those keywords (may span multiple lines)
4. If NOT found after thorough search → mark as not attempted

RULES:
- IGNORE all section headers (Q1, Q2, etc.) in the OCR — students frequently write WRONG section numbers
- An answer may span multiple lines or continue after a page break
- Do NOT infer an answer from the question text itself
- Each piece of student writing belongs to exactly ONE question
- Copy OCR text VERBATIM into student_answer. Do NOT complete unfinished equations, rewrite into textbook form, correct the student's chemistry, or invent a final/boxed answer. If the student left work incomplete, keep it incomplete.
- Put struck-through OCR into crossed_out_work only when clearly crossed out; otherwise leave it empty
- Set attempted=false with HIGH confidence ONLY when keywords are completely absent from the OCR
- If keywords exist but context is unclear, set attempted=true with LOW confidence
- Keep every [unread region] marker exactly where it appears in the student's answer: it is handwriting the OCR could not read. Never drop it or guess what it says
- Set needs_visual_rescue=true only when the answer depends on a diagram/graph/image

CANONICAL QUESTIONS:
${JSON.stringify(questionList)}

STUDENT ANSWER SHEET OCR:
${ocrText}

Return JSON only: {"answers":[{"question_number":"","attempted":false,"student_answer":"","crossed_out_work":"","source_pages":[0],"confidence":"low|medium|high","needs_visual_rescue":false,"visual_reason":""}]}`;
}

// ─── Reasoning Effort Selection ───────────────────────────────────────────────

/**
 * Choose reasoning effort based on chunk content.
 */
export function selectReasoningEffort(chunk) {
  const types = chunk.questions.map(classifyQuestionType);
  const hasLong = types.includes('long');
  const allMcq = types.every((t) => t === 'mcq');
  if (allMcq) return 'low';
  if (hasLong) return 'medium';
  return 'low';
}

/**
 * Choose max_tokens based on chunk size.
 * Reasoning models need headroom: ~3000 reasoning + ~150/question for JSON output.
 */
export function selectMaxTokens(chunk) {
  const count = chunk.questions.length;
  return Math.min(16000, 3000 + count * 500);
}

// ─── OCR Stats ────────────────────────────────────────────────────────────────

/**
 * Compute OCR quality stats for supervisor pre-flight.
 */
export function computeOcrStats(pages) {
  const charCounts = pages.map((p) => (p.markdown || '').length);
  const total = charCounts.reduce((a, b) => a + b, 0);
  const nonEmpty = charCounts.filter((c) => c > 50);
  return {
    totalPages: pages.length,
    totalChars: total,
    avgCharsPerPage: pages.length ? Math.round(total / pages.length) : 0,
    nonEmptyPages: nonEmpty.length,
    noiseRatio: total > 0 ? (total - cleanAndMergePages(pages).length) / total : 0,
  };
}
