/**
 * Practice test generate + typed-answer grading.
 *
 * Practice→Hive policy: write evidence_signals only (extractor_version=practice_v1).
 * Never write learner_dna here — synthesis owns DNA when deep_signals is on.
 */

import { randomUUID } from 'node:crypto';
import { assessEvidenceReadiness, buildStudentContext, InsufficientEvidenceError } from './contextBuilder.js';
import { getStudentCurriculum } from './curriculumMap.js';
import { callJsonModel } from './llmGateway.js';
import { listQuestionBank, upsertQuestionBankItem } from './questionBank.js';

function text(value) {
  return String(value || '').trim();
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

function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function weakTopicsFromContext(context) {
  const fromKc = [...(context.mastery || [])]
    .map((row) => ({ topic: text(row.kcLabel || row.topic), theta: Number(row.thetaMean) || 0 }))
    .filter((row) => row.topic)
    .sort((a, b) => a.theta - b.theta)
    .filter((row) => row.theta < 0.7)
    .map((row) => row.topic);
  const fromSignals = [];
  for (const signal of context.signals || []) {
    if (signal.misconception && signal.topic) fromSignals.push(text(signal.topic));
  }
  return [...new Set([...fromKc, ...fromSignals])].slice(0, 5);
}

export function normalizeGeneratedQuestions(raw, { subject, topics, count }) {
  const list = Array.isArray(raw?.questions) ? raw.questions : Array.isArray(raw) ? raw : [];
  return list.slice(0, count).map((item, index) => {
    const maxMarks = Number(item.max_marks ?? item.maxMarks ?? 2) || 2;
    return {
      id: text(item.id) || `pq_${index + 1}`,
      topic: text(item.topic) || topics[index % Math.max(topics.length, 1)] || subject,
      difficulty: text(item.difficulty) || 'medium',
      questionType: text(item.question_type || item.questionType) || 'subjective',
      questionText: text(item.question_text || item.questionText),
      answerKey: text(item.answer_key || item.answerKey),
      maxMarks,
      rubric: item.rubric || { marking: text(item.marking) || 'Award partial credit for correct method.' },
      bankId: text(item.bank_id || item.bankId) || null,
    };
  }).filter((item) => item.questionText);
}

/**
 * Summarize graded practice for Hive / UI.
 * Pure helper — does not write. feedsDna reflects whether signals were (or will be) written.
 */
export function practiceResultsForDnaFeed({ practiceTest, submission, feedsDna = false, written = 0, reason = null } = {}) {
  const questions = parseJson(practiceTest?.questions_json, practiceTest?.questions || []);
  const grades = parseJson(submission?.feedback_json, submission?.feedback || {});
  const perQuestion = Array.isArray(grades.questions) ? grades.questions : [];
  const byTopic = new Map();
  for (const grade of perQuestion) {
    const question = questions.find((item) => item.id === grade.questionId) || {};
    const topic = text(question.topic) || 'General';
    const entry = byTopic.get(topic) || { topic, obtained: 0, total: 0, count: 0 };
    entry.obtained += Number(grade.marksObtained) || 0;
    entry.total += Number(grade.maxMarks || question.maxMarks) || 0;
    entry.count += 1;
    byTopic.set(topic, entry);
  }
  return {
    feedsDna: Boolean(feedsDna),
    reason: reason || (feedsDna
      ? 'Wrote practice evidence_signals for Hive synthesis'
      : 'Practice→Hive deferred (missing student or deep_signals off)'),
    practiceTestId: practiceTest?.id || null,
    submissionId: submission?.id || null,
    written: Number(written) || 0,
    topicOutcomes: [...byTopic.values()].map((row) => ({
      topic: row.topic,
      pct: row.total > 0 ? Math.round((row.obtained / row.total) * 100) : null,
      questions: row.count,
    })),
  };
}

async function schoolHasDeepSignals(db, schoolId) {
  if (!db || !schoolId) return false;
  try {
    const result = await db.execute({
      sql: `SELECT enabled FROM school_feature_flags
            WHERE school_id = ? AND feature_key = 'deep_signals' LIMIT 1`,
      args: [schoolId],
    });
    return Number(result.rows[0]?.enabled) === 1;
  } catch {
    return false;
  }
}

/**
 * Upsert practice grades into evidence_signals (Hive input). Does not touch learner_dna.
 * Uses synthetic submission_question_id = psq_<practiceSubmissionId>_<questionId>.
 */
export async function writePracticeSignalsToHive(db, {
  schoolId,
  studentId,
  practiceSubmissionId,
  practiceTest,
  questionGrades = [],
  model = null,
  extractedAt = new Date().toISOString(),
} = {}) {
  if (!db) throw new Error('database client is required');
  if (!schoolId || !studentId || !practiceSubmissionId) {
    return { written: 0, reason: 'schoolId, studentId, and practiceSubmissionId are required' };
  }
  const questions = Array.isArray(practiceTest?.questions) ? practiceTest.questions : [];
  let written = 0;
  for (const grade of questionGrades) {
    const question = questions.find((item) => item.id === grade.questionId) || {};
    const questionId = text(grade.questionId || question.id);
    if (!questionId) continue;
    const maxMarks = Number(grade.maxMarks || question.maxMarks) || 0;
    const marksObtained = Number(grade.marksObtained) || 0;
    const pct = maxMarks > 0 ? marksObtained / maxMarks : 0;
    const feedback = text(grade.feedback);
    const topic = text(question.topic) || 'General';
    const submissionQuestionId = `psq_${practiceSubmissionId}_${questionId}`.slice(0, 120);
    const signalId = id('esig');
    await db.execute({
      sql: `INSERT INTO evidence_signals (
              id, school_id, student_id, submission_id, submission_question_id, exam_id,
              question_number, topic, marks_obtained, marks_total, concept_tags_json,
              misconception, strength, method_note, next_practice, confidence,
              evidence_refs_json, raw_json, model, extractor_version, status, extracted_at, created_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'practice_v1', 'active', ?, ?)
            ON CONFLICT(submission_question_id) DO UPDATE SET
              topic = excluded.topic,
              marks_obtained = excluded.marks_obtained,
              marks_total = excluded.marks_total,
              misconception = excluded.misconception,
              strength = excluded.strength,
              method_note = excluded.method_note,
              next_practice = excluded.next_practice,
              confidence = excluded.confidence,
              evidence_refs_json = excluded.evidence_refs_json,
              raw_json = excluded.raw_json,
              model = excluded.model,
              extractor_version = excluded.extractor_version,
              status = 'active',
              extracted_at = excluded.extracted_at`,
      args: [
        signalId,
        schoolId,
        studentId,
        practiceSubmissionId,
        submissionQuestionId,
        questionId,
        topic,
        marksObtained,
        maxMarks,
        JSON.stringify([topic].filter(Boolean)),
        pct < 0.5 && feedback ? feedback.slice(0, 400) : null,
        pct >= 0.8 && feedback ? feedback.slice(0, 400) : null,
        feedback ? feedback.slice(0, 400) : null,
        pct < 0.7 ? `Revisit ${topic} with a short mixed set` : `Keep drilling ${topic} at harder difficulty`,
        0.55,
        JSON.stringify([`practice:${practiceSubmissionId}:${questionId}`]),
        JSON.stringify({
          source: 'practice',
          practiceTestId: practiceTest?.id || null,
          isCorrect: Boolean(grade.isCorrect),
          pct,
        }),
        model,
        extractedAt,
        extractedAt,
      ],
    });
    written += 1;
  }
  return { written, reason: written ? null : 'no question grades' };
}

export async function getPracticeTest(db, { practiceTestId, schoolId }) {
  const result = await db.execute({
    sql: `SELECT * FROM practice_tests WHERE id = ? AND school_id = ? LIMIT 1`,
    args: [practiceTestId, schoolId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    studentId: row.student_id,
    schoolId: row.school_id,
    username: row.username,
    subject: row.subject,
    topicFocus: parseJson(row.topic_focus_json, []),
    questions: parseJson(row.questions_json, []),
    difficultyProfile: parseJson(row.difficulty_profile_json, {}),
    totalMarks: Number(row.total_marks) || 0,
    status: row.status,
    generatedBy: row.generated_by,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listPracticeTests(db, { schoolId, username = null, limit = 20 } = {}) {
  if (!db) throw new Error('database client is required');
  if (!schoolId) throw new Error('schoolId is required');
  const max = Math.max(1, Math.min(50, Number(limit) || 20));
  const result = await db.execute({
    sql: `SELECT id, username, subject, topic_focus_json, total_marks, status, created_at
            FROM practice_tests
           WHERE school_id = ?${username ? ' AND username = ?' : ''}
           ORDER BY created_at DESC
           LIMIT ?`,
    args: username ? [schoolId, username, max] : [schoolId, max],
  });
  const tests = (result.rows || []).map((row) => ({
    id: row.id,
    username: row.username,
    subject: row.subject,
    topicFocus: parseJson(row.topic_focus_json, []),
    totalMarks: Number(row.total_marks) || 0,
    status: row.status,
    createdAt: row.created_at,
    score: null,
  }));
  if (!tests.length) return tests;
  const ids = tests.map((row) => row.id);
  const graded = await db.execute({
    sql: `SELECT practice_test_id, score
            FROM practice_submissions
           WHERE school_id = ?
             AND practice_test_id IN (${ids.map(() => '?').join(', ')})`,
    args: [schoolId, ...ids],
  }).catch(() => ({ rows: [] }));
  const scoreByTest = new Map();
  for (const row of graded.rows || []) scoreByTest.set(row.practice_test_id, Number(row.score));
  for (const test of tests) if (scoreByTest.has(test.id)) test.score = scoreByTest.get(test.id);
  return tests;
}

export async function generatePracticeTest(db, {
  schoolId,
  username = null,
  studentId = null,
  subject = 'Mathematics',
  topics = null,
  count = 5,
  generatedBy = 'self_request',
  callModel = null,
  persistBank = true,
} = {}) {
  if (!schoolId) throw new Error('schoolId is required');
  const context = await buildStudentContext(db, {
    schoolId,
    username: username || undefined,
    studentId: studentId || undefined,
    signalLimit: 30,
  });

  let focusTopics = Array.isArray(topics) && topics.length
    ? topics.map(text).filter(Boolean)
    : weakTopicsFromContext(context);

  if (!focusTopics.length && context.studentId) {
    const pack = await getStudentCurriculum(db, {
      schoolId,
      studentId: context.studentId,
      subject,
    }).catch(() => null);
    focusTopics = (pack?.standards || []).slice(0, 3).map((row) => row.topic);
  }
  if (!focusTopics.length) focusTopics = [subject];

  const bankHits = [];
  for (const topic of focusTopics.slice(0, 3)) {
    const rows = await listQuestionBank(db, {
      subject,
      topic,
      status: 'active',
      limit: 3,
    }).catch(() => []);
    bankHits.push(...rows);
  }

  // Evidence gate: personalized generation needs real signals.
  // Exception: caller picked explicit topics and the bank can serve them (curated reuse).
  const readiness = assessEvidenceReadiness(context);
  const explicitTopics = Array.isArray(topics) && topics.length > 0;
  if (readiness.level !== 'ok' && !(explicitTopics && bankHits.length > 0)) {
    throw new InsufficientEvidenceError(readiness);
  }

  let questions = bankHits.slice(0, count).map((row, index) => ({
    id: `pq_${index + 1}`,
    topic: row.topic || focusTopics[0],
    difficulty: row.difficulty || 'medium',
    questionType: row.questionType || 'subjective',
    questionText: row.questionText,
    answerKey: row.answerKey || '',
    maxMarks: row.maxMarks || 2,
    rubric: row.rubric || {},
    bankId: row.id,
  }));

  let model = null;
  if (questions.length < count) {
    const needed = count - questions.length;
    const prompt = [
      `Generate ${needed} short ${subject} practice questions as JSON:`,
      '{"questions":[{"topic":"","difficulty":"easy|medium|hard","question_type":"subjective","question_text":"","answer_key":"","max_marks":2,"marking":""}]}',
      `Focus topics: ${JSON.stringify(focusTopics)}`,
      'Keep questions typed-answer friendly (no diagrams). Do not invent student performance.',
      `Student growth edge (style only): ${JSON.stringify(context.dna?.growth_edge || null)}`,
    ].join('\n');

    try {
      const generated = callModel
        ? await callModel({ prompt, topics: focusTopics })
        : await callJsonModel({
          prompt,
          maxTokens: 1600,
          model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
          system: 'You write board-aligned practice questions. Return valid JSON only.',
        });
      model = generated.model || null;
      const generatedQuestions = normalizeGeneratedQuestions(generated.result || generated, {
        subject,
        topics: focusTopics,
        count: needed,
      });
      questions = [
        ...questions,
        ...generatedQuestions.map((item, index) => ({
          ...item,
          id: `pq_${questions.length + index + 1}`,
        })),
      ];
    } catch {
      if (!questions.length) {
        throw new Error('Practice question generation failed — model unavailable');
      }
      // Bank-served questions already collected; ship those rather than inventing.
    }
  }

  if (!questions.length) {
    throw new Error('Practice question generation produced no questions');
  }

  if (persistBank) {
    for (const question of questions) {
      if (question.bankId || !question.questionText) continue;
      try {
        const saved = await upsertQuestionBankItem(db, {
          board: context.board || null,
          grade: context.className || null,
          subject,
          topic: question.topic,
          difficulty: question.difficulty,
          questionType: question.questionType,
          questionText: question.questionText,
          answerKey: question.answerKey,
          rubric: question.rubric,
          maxMarks: question.maxMarks,
          source: 'ai_generated',
          qualityScore: 0.55,
        });
        question.bankId = saved.id;
      } catch {
        /* bank table may be absent in unit tests */
      }
    }
  }

  const difficultyProfile = questions.reduce((acc, question) => {
    const key = question.difficulty || 'medium';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const totalMarks = questions.reduce((sum, question) => sum + (Number(question.maxMarks) || 0), 0);
  const at = new Date().toISOString();
  const practiceTestId = id('pt');

  await db.execute({
    sql: `INSERT INTO practice_tests (
            id, student_id, school_id, username, subject, topic_focus_json, questions_json,
            difficulty_profile_json, total_marks, status, generated_by, model, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'generated', ?, ?, ?, ?)`,
    args: [
      practiceTestId,
      context.studentId || studentId || null,
      schoolId,
      context.username || username || null,
      subject,
      JSON.stringify(focusTopics),
      JSON.stringify(questions),
      JSON.stringify(difficultyProfile),
      totalMarks,
      generatedBy,
      model,
      at,
      at,
    ],
  });

  return {
    id: practiceTestId,
    studentId: context.studentId || studentId || null,
    username: context.username || username || null,
    schoolId,
    subject,
    topicFocus: focusTopics,
    questions,
    difficultyProfile,
    totalMarks,
    status: 'generated',
    generatedBy,
    model,
    createdAt: at,
  };
}

export async function gradePracticeSubmission(db, {
  schoolId,
  practiceTestId,
  answers = [],
  username = null,
  studentId = null,
  callModel = null,
} = {}) {
  if (!schoolId) throw new Error('schoolId is required');
  if (!practiceTestId) throw new Error('practiceTestId is required');

  const practiceTest = await getPracticeTest(db, { practiceTestId, schoolId });
  if (!practiceTest) throw new Error('Practice test not found');

  const answerList = Array.isArray(answers) ? answers : [];
  const prompt = [
    'Grade these typed practice answers. Return JSON only:',
    '{"questions":[{"questionId":"","marksObtained":0,"maxMarks":0,"feedback":"","isCorrect":false}],"overall_feedback":""}',
    'Award partial credit for correct method. Never invent answer content the student did not write.',
    `Questions: ${JSON.stringify(practiceTest.questions.map((q) => ({
      id: q.id,
      topic: q.topic,
      questionText: q.questionText,
      answerKey: q.answerKey,
      maxMarks: q.maxMarks,
      rubric: q.rubric,
    })))}`,
    `Student answers: ${JSON.stringify(answerList)}`,
  ].join('\n');

  let model = null;
  let graded;
  try {
    const generated = callModel
      ? await callModel({ prompt, practiceTest, answers: answerList })
      : await callJsonModel({
        prompt,
        maxTokens: 1400,
        model: process.env.DEEPSEEK_FLASH_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        system: 'You grade typed practice answers fairly with partial credit. Return valid JSON only.',
      });
    model = generated.model || null;
    graded = generated.result || generated;
  } catch {
    throw new Error('Grading is temporarily unavailable — please try again in a moment');
  }

  const questionGrades = (Array.isArray(graded.questions) ? graded.questions : []).map((row) => {
    const question = practiceTest.questions.find((item) => item.id === row.questionId) || {};
    const maxMarks = Number(row.maxMarks ?? question.maxMarks ?? 0) || 0;
    const marksObtained = Math.max(0, Math.min(maxMarks, Number(row.marksObtained) || 0));
    return {
      questionId: row.questionId || question.id,
      marksObtained,
      maxMarks,
      feedback: text(row.feedback),
      isCorrect: Boolean(row.isCorrect),
    };
  });

  const score = questionGrades.reduce((sum, row) => sum + row.marksObtained, 0);
  const maxMarks = practiceTest.totalMarks
    || questionGrades.reduce((sum, row) => sum + row.maxMarks, 0);
  const at = new Date().toISOString();
  const submissionId = id('ps');
  const feedback = {
    questions: questionGrades,
    overall_feedback: text(graded.overall_feedback) || null,
  };

  await db.execute({
    sql: `INSERT INTO practice_submissions (
            id, practice_test_id, student_id, school_id, username, answers_json,
            score, max_marks, feedback_json, evidence_json, model, status, graded_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'graded', ?, ?, ?)`,
    args: [
      submissionId,
      practiceTestId,
      practiceTest.studentId || studentId || null,
      schoolId,
      practiceTest.username || username || null,
      JSON.stringify(answerList),
      score,
      maxMarks,
      JSON.stringify(feedback),
      model,
      at,
      at,
      at,
    ],
  });

  await db.execute({
    sql: `UPDATE practice_tests SET status = 'graded', updated_at = ? WHERE id = ? AND school_id = ?`,
    args: [at, practiceTestId, schoolId],
  });

  const dnaStudentId = practiceTest.studentId || studentId || null;
  let feedMeta = { feedsDna: false, written: 0, reason: null };
  if (dnaStudentId && await schoolHasDeepSignals(db, schoolId)) {
    try {
      const wrote = await writePracticeSignalsToHive(db, {
        schoolId,
        studentId: dnaStudentId,
        practiceSubmissionId: submissionId,
        practiceTest,
        questionGrades,
        model,
        extractedAt: at,
      });
      feedMeta = {
        feedsDna: wrote.written > 0,
        written: wrote.written,
        reason: wrote.reason,
      };
    } catch (error) {
      feedMeta = {
        feedsDna: false,
        written: 0,
        reason: `Practice signal write failed: ${String(error.message || error)}`,
      };
    }
  } else if (!dnaStudentId) {
    feedMeta.reason = 'No studentId on practice test — Hive feed skipped';
  } else {
    feedMeta.reason = 'deep_signals flag off for school — Hive feed skipped';
  }

  const dnaFeed = practiceResultsForDnaFeed({
    practiceTest: { ...practiceTest, questions_json: practiceTest.questions },
    submission: { id: submissionId, feedback_json: feedback },
    feedsDna: feedMeta.feedsDna,
    written: feedMeta.written,
    reason: feedMeta.reason,
  });

  return {
    id: submissionId,
    practiceTestId,
    score,
    maxMarks,
    feedback,
    model,
    gradedAt: at,
    dnaFeed,
  };
}
