/**
 * Curriculum standards lookup + fuzzy topic matching for AI surfaces.
 */

function text(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return text(value)
    .toLowerCase()
    .normalize('NFKC')
    // Keep letters/numbers across scripts (Latin + Devanagari, etc.).
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToStandard(row) {
  if (!row) return null;
  return {
    id: row.id,
    board: row.board,
    grade: row.grade,
    subject: row.subject,
    topic: row.topic,
    subTopics: parseJson(row.sub_topics_json, []),
    difficultyWeight: row.difficulty_weight == null ? null : Number(row.difficulty_weight),
    createdAt: row.created_at || null,
  };
}

/**
 * List curriculum standards with optional filters.
 *
 * @param {object} db
 * @param {{ board?: string, grade?: string, subject?: string, topic?: string, limit?: number }} [filters]
 */
export async function listCurriculumStandards(db, filters = {}) {
  if (!db) throw new Error('database client is required');
  const clauses = [];
  const args = [];
  if (filters.board) {
    clauses.push('LOWER(board) = LOWER(?)');
    args.push(text(filters.board));
  }
  if (filters.grade) {
    clauses.push('LOWER(grade) = LOWER(?)');
    args.push(text(filters.grade));
  }
  if (filters.subject) {
    clauses.push('LOWER(subject) = LOWER(?)');
    args.push(text(filters.subject));
  }
  if (filters.topic) {
    clauses.push('(LOWER(topic) LIKE ? OR id LIKE ?)');
    const needle = `%${normalizeKey(filters.topic).replace(/\s+/g, '%')}%`;
    args.push(needle, `%${normalizeKey(filters.topic).replace(/\s+/g, '_')}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(500, Number(filters.limit) || 200));
  args.push(limit);
  const result = await db.execute({
    sql: `SELECT id, board, grade, subject, topic, sub_topics_json, difficulty_weight, created_at
          FROM curriculum_standards
          ${where}
          ORDER BY board, grade, subject, topic
          LIMIT ?`,
    args,
  });
  return result.rows.map(rowToStandard);
}

/**
 * Score how well a free-text topic matches a curriculum standard.
 * Pure helper — exported for tests and mapping scripts.
 */
export function scoreTopicMatch(sourceTopic, standard) {
  const source = normalizeKey(sourceTopic);
  if (!source || !standard) return 0;
  const topic = normalizeKey(standard.topic);
  const idMatch = String(standard.id || '').match(/_(?:math|phys|chem|bio|english|hindi|accounts)_(.+)$/i);
  const idTail = normalizeKey((idMatch?.[1] || '').replace(/_/g, ' '));
  const subKeys = (standard.subTopics || []).map((item) => normalizeKey(item)).filter(Boolean);
  if (!topic) return 0;
  if (source === topic) return 1;
  if (topic.includes(source) || source.includes(topic)) return 0.92;
  // Exact / contained subtopic aliases (live free-text → official chapter).
  for (const subKey of subKeys) {
    if (source === subKey) return 0.9;
    if (subKey.length >= 8 && (source.includes(subKey) || subKey.includes(source))) return 0.88;
  }
  if (idTail && (source.includes(idTail.replace(/\s+/g, ' ')) || idTail.includes(source))) return 0.85;

  const sourceTokens = new Set(source.split(' ').filter((token) => token.length > 2));
  const stopTokens = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'law', 'laws', 'some', 'basic', 'unit', 'units']);
  const topicTokens = new Set([
    ...topic.split(' ').filter((token) => token.length > 2),
    ...idTail.split(' ').filter((token) => token.length > 2),
    ...subKeys.flatMap((item) => item.split(' ').filter((token) => token.length > 2)),
  ]);
  if (!sourceTokens.size || !topicTokens.size) return 0;

  let overlap = 0;
  let distinctiveOverlap = 0;
  for (const token of sourceTokens) {
    if (!topicTokens.has(token)) continue;
    overlap += 1;
    if (!stopTokens.has(token)) distinctiveOverlap += 1;
  }
  if (!overlap) {
    // fall through to boost-only checks below with zero overlap
  } else if (distinctiveOverlap === 0 && overlap > 0) {
    // Shared only stopwords like "law" — ignore token score; boosts may still apply.
    overlap = 0;
  }

  // Distinctive curriculum tokens boost weak free-text topics (math + science).
  const boostTokens = new Set([
    'identity', 'identities', 'quadratic', 'polynomial', 'polynomials',
    'trigonometry', 'trigonometric', 'probability', 'mensuration',
    'circle', 'circles', 'triangle', 'triangles',
    'mole', 'colligative', 'raoult', 'electrostatics', 'electromagnetic',
    'induction', 'solutions', 'kinetics', 'inheritance',
  ]);
  let boost = 0;
  for (const token of sourceTokens) {
    if (boostTokens.has(token) && topicTokens.has(token)) boost = Math.max(boost, 0.55);
  }
  if (source.includes('identity') && topic.includes('identit')) boost = Math.max(boost, 0.6);
  if ((source.includes('sin') || source.includes('cos') || source.includes('tan')) && topic.includes('trig')) {
    boost = Math.max(boost, 0.58);
  }
  if (source.includes('mole') && topic.includes('basic concept')) {
    boost = Math.max(boost, 0.62);
  }
  if ((source.includes('van') || source.includes('hoff') || source.includes('colligative') || source.includes('henry'))
    && topic.includes('solution')) {
    boost = Math.max(boost, 0.62);
  }

  // Prefer coverage of the source phrase so rich sub_topics catalogues don't dilute scores.
  const coverage = overlap ? overlap / sourceTokens.size : 0;
  const ratio = overlap ? overlap / Math.max(sourceTokens.size, topicTokens.size) : 0;
  const best = Math.max(ratio, coverage * 0.92);
  const scored = best >= 0.6
    ? 0.7 + best * 0.2
    : best >= 0.34
      ? 0.45 + best * 0.2
      : 0;
  return Math.max(scored, boost);
}

/**
 * Find the best curriculum match for a free-text topic within a board/grade/subject slice.
 */
export function findBestCurriculumMatch(sourceTopic, standards, { minScore = 0.45 } = {}) {
  let best = null;
  for (const standard of standards || []) {
    const score = scoreTopicMatch(sourceTopic, standard);
    if (score < minScore) continue;
    if (!best || score > best.score) best = { standard, score };
  }
  return best;
}

/**
 * Resolve a student's board (batches) + grade (enrollments) and load matching standards.
 */
export async function getStudentCurriculum(db, { schoolId, studentId, subject = 'Mathematics' } = {}) {
  const scopedSchoolId = text(schoolId);
  const scopedStudentId = text(studentId);
  if (!scopedSchoolId) throw new Error('schoolId is required');
  if (!scopedStudentId) throw new Error('studentId is required');
  if (!db) throw new Error('database client is required');

  const boardRow = (await db.execute({
    sql: `SELECT batch.board, batch.grade
          FROM batch_memberships membership
          JOIN batches batch
            ON batch.id = membership.batch_id
           AND batch.school_id = ?
           AND batch.status = 'active'
          WHERE membership.student_id = ?
            AND membership.status = 'active'
          ORDER BY batch.updated_at DESC
          LIMIT 1`,
    args: [scopedSchoolId, scopedStudentId],
  }).catch(() => ({ rows: [] }))).rows[0];

  const enrollment = (await db.execute({
    sql: `SELECT enrollment.standard
          FROM student_enrollments enrollment
          JOIN academic_years year ON year.id = enrollment.academic_year_id
          WHERE enrollment.student_id = ?
            AND enrollment.status = 'active'
            AND year.school_id = ?
            AND year.is_current = 1
          ORDER BY enrollment.updated_at DESC
          LIMIT 1`,
    args: [scopedStudentId, scopedSchoolId],
  }).catch(() => ({ rows: [] }))).rows[0];

  const board = text(boardRow?.board) || null;
  const grade = text(enrollment?.standard) || text(boardRow?.grade) || null;
  const standards = await listCurriculumStandards(db, {
    board: board || undefined,
    grade: grade || undefined,
    subject,
    limit: 300,
  });

  return { schoolId: scopedSchoolId, studentId: scopedStudentId, board, grade, subject, standards };
}

/**
 * Upsert a proposed/approved link from an exam_set_question to a curriculum standard.
 */
export async function upsertQuestionCurriculumLink(db, {
  examSetQuestionId,
  curriculumStandardId,
  sourceTopic = null,
  confidence = null,
  source = 'heuristic',
  status = 'proposed',
  reviewedBy = null,
  at = new Date().toISOString(),
  linkId = null,
} = {}) {
  if (!db) throw new Error('database client is required');
  const questionId = text(examSetQuestionId);
  const standardId = text(curriculumStandardId);
  if (!questionId || !standardId) throw new Error('examSetQuestionId and curriculumStandardId are required');

  const id = text(linkId) || `eql_${questionId.slice(-18)}`;
  await db.execute({
    sql: `INSERT INTO exam_question_curriculum_links (
            id, exam_set_question_id, curriculum_standard_id, source_topic, confidence,
            source, status, reviewed_by, reviewed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(exam_set_question_id) DO UPDATE SET
            curriculum_standard_id = excluded.curriculum_standard_id,
            source_topic = excluded.source_topic,
            confidence = excluded.confidence,
            source = excluded.source,
            status = excluded.status,
            reviewed_by = excluded.reviewed_by,
            reviewed_at = excluded.reviewed_at,
            updated_at = excluded.updated_at`,
    args: [
      id,
      questionId,
      standardId,
      sourceTopic,
      confidence,
      source,
      status,
      reviewedBy,
      reviewedBy ? at : null,
      at,
      at,
    ],
  });
  return { id, examSetQuestionId: questionId, curriculumStandardId: standardId, status };
}
