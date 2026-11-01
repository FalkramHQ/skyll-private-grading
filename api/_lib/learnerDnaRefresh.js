/**
 * Shared Learner DNA refresh logic.
 *
 * Called after a new report is published to update the student's
 * "brain" — the longitudinal DNA stored in the learner_dna table.
 * This ensures the DNA is always up-to-date without computing it
 * on every API call.
 */

const MODE_LABELS = {
  architect: 'The Architect - Concept building',
  pathfinder: 'The Pathfinder - Problem interpretation and method selection',
  maker: 'The Maker - Execution and completion',
  cartographer: 'The Cartographer - Representation across diagrams, notation, equations, graphs, and data',
  calibrator: 'The Calibrator - Verification and correction',
  bridgebuilder: 'The Bridgebuilder - Transfer to a changed question form or context',
};

const ALL_MODES = ['architect', 'pathfinder', 'maker', 'cartographer', 'calibrator', 'bridgebuilder'];

function aggregateTopics(allQuestions) {
  const topicMap = {};
  for (const q of allQuestions) {
    const topic = q.topic || q._topic || 'General';
    if (!topicMap[topic]) {
      topicMap[topic] = { topic, exams: new Set(), correct: 0, partial: 0, missed: 0, totalQuestions: 0, marksObtained: 0, marksTotal: 0 };
    }
    const entry = topicMap[topic];
    entry.exams.add(q._examName || 'Assessment');
    entry.totalQuestions++;
    entry.marksObtained += Number(q.marks_obtained || 0);
    entry.marksTotal += Number(q.marks_total || 0);
    if (Number(q.marks_total) > 0 && Number(q.marks_obtained) >= Number(q.marks_total)) entry.correct++;
    else if (Number(q.marks_obtained) > 0) entry.partial++;
    else entry.missed++;
  }
  return Object.values(topicMap).map((t) => ({
    topic: t.topic,
    exam_count: t.exams.size,
    exam_names: [...t.exams],
    correct: t.correct,
    partial: t.partial,
    missed: t.missed,
    total_questions: t.totalQuestions,
    marks_obtained: t.marksObtained,
    marks_total: t.marksTotal,
    pct: t.marksTotal > 0 ? Math.round((t.marksObtained / t.marksTotal) * 100) : 0,
  })).sort((a, b) => b.marksTotal - a.marksTotal);
}

export function generateLongitudinalDna(reports) {
  if (reports.length < 2) return null;

  const allQuestions = [];
  const examMeta = [];

  for (const report of reports) {
    const examInfo = (report.exams || [])[0] || { id: report.workflow?.test_id || 'unknown', name: 'Assessment', date: '' };
    examMeta.push(examInfo);
    const examName = examInfo.name || 'Assessment';

    for (const subject of (report.term1?.subjects || [])) {
      for (const q of (subject.questions || [])) {
        allQuestions.push({
          ...q,
          _examName: examName,
          _examId: examInfo.id,
          _subject: subject.name || 'Subject',
          _topic: q.topic || 'General',
        });
      }
    }
  }

  if (!allQuestions.length) return null;

  const total = allQuestions.reduce((s, q) => s + Number(q.marks_total || 0), 0);
  const score = allQuestions.reduce((s, q) => s + Number(q.marks_obtained || 0), 0);
  const correct = allQuestions.filter((q) => Number(q.marks_total) > 0 && Number(q.marks_obtained) >= Number(q.marks_total));
  const missed = allQuestions.filter((q) => Number(q.marks_obtained) < Number(q.marks_total));
  const ratio = score / Math.max(total, 1);
  const primary = ratio >= 0.75 ? 'calibrator' : ratio >= 0.45 ? 'pathfinder' : 'maker';
  const edge = ratio >= 0.75 ? 'architect' : 'calibrator';

  const topics = aggregateTopics(allQuestions);
  const consistentStrengths = topics.filter((t) => t.exam_count >= 2 && t.pct >= 75).map((t) => ({ topic: t.topic, exams: t.exam_names, evidence: `${t.correct}/${t.total_questions} correct across ${t.exam_count} exams` }));
  const recurringGaps = topics.filter((t) => t.exam_count >= 2 && t.pct < 45).map((t) => ({ topic: t.topic, exams: t.exam_names, evidence: `${t.missed}/${t.total_questions} questions missed across ${t.exam_count} exams` }));

  const examBreakdown = examMeta.map((exam) => {
    const examQuestions = allQuestions.filter((q) => q._examId === exam.id);
    const examScore = examQuestions.reduce((s, q) => s + Number(q.marks_obtained || 0), 0);
    const examTotal = examQuestions.reduce((s, q) => s + Number(q.marks_total || 0), 0);
    return { id: exam.id, name: exam.name || 'Assessment', date: exam.date || '', score: examScore, total: examTotal, pct: examTotal > 0 ? Math.round((examScore / examTotal) * 100) : 0, question_count: examQuestions.length };
  });

  let trajectory = 'stable';
  if (examBreakdown.length >= 2) {
    const recent = examBreakdown[0];
    const older = examBreakdown[examBreakdown.length - 1];
    if (recent.pct > older.pct + 10) trajectory = 'improving';
    else if (recent.pct < older.pct - 10) trajectory = 'declining';
  }

  const dimensions = ALL_MODES.map((modeId) => {
    if (modeId === primary) {
      return { id: modeId, label: MODE_LABELS[modeId], state: ratio >= 0.75 ? 'secure' : ratio >= 0.45 ? 'developing' : 'needs_practice', score: Math.round(ratio * 100), evidence_count: correct.length, evidence_question_ids: correct.slice(0, 8).map((q) => String(q.number)) };
    }
    if (modeId === edge) {
      return { id: modeId, label: MODE_LABELS[modeId], state: missed.length ? 'needs_practice' : 'secure', score: Math.round(ratio * 100), evidence_count: missed.length, evidence_question_ids: missed.slice(0, 8).map((q) => String(q.number)) };
    }
    return { id: modeId, label: MODE_LABELS[modeId], state: 'not_observed', score: null, evidence_count: 0, evidence_question_ids: [] };
  });

  const primaryLabel = MODE_LABELS[primary] || '';
  const subjectCount = new Set(allQuestions.map((q) => q._subject)).size;

  return {
    schema_version: 2,
    assessment_scope: {
      level: 'longitudinal_dna',
      detail: `Based on ${reports.length} assessments, ${allQuestions.length} questions, and ${subjectCount} subject${subjectCount === 1 ? '' : 's'} across ${examMeta.length} exam${examMeta.length === 1 ? '' : 's'}.`,
    },
    primary_mode: {
      mode_id: primary,
      title: primaryLabel,
      description: `Across all assessments, ${correct.length} of ${allQuestions.length} questions were fully solved (${Math.round(ratio * 100)}%). ${trajectory === 'improving' ? 'Performance is trending upward.' : trajectory === 'declining' ? 'Recent assessments show a dip — revisit fundamentals.' : 'Performance is stable.'}`,
      evidence: `${score}/${total} marks across ${allQuestions.length} questions in ${reports.length} assessments.`,
    },
    growth_edge: {
      mode_id: edge,
      title: MODE_LABELS[edge] || 'Choose one next skill to practise',
      action: recurringGaps.length
        ? `Recurring gap: ${recurringGaps[0].topic} (${recurringGaps[0].evidence}). Start here.`
        : consistentStrengths.length
          ? `Build on ${consistentStrengths[0].topic} by solving harder variants.`
          : 'Focus on one missed question per exam and compare with the solution.',
      evidence: `${missed.length} questions lost marks across all assessments. ${recurringGaps.length ? `${recurringGaps.length} recurring gap${recurringGaps.length === 1 ? '' : 's'} detected.` : 'No recurring gaps yet — keep building evidence.'}`,
    },
    dimensions,
    topic_mastery: topics.slice(0, 12),
    cross_exam_patterns: {
      consistent_strengths: consistentStrengths.slice(0, 5),
      recurring_gaps: recurringGaps.slice(0, 5),
      trajectory,
    },
    exam_breakdown: examBreakdown,
    next_move: {
      title: 'Turn the feedback into a repeatable habit',
      action: recurringGaps.length
        ? `Pick ${recurringGaps[0].topic} — it appeared in ${recurringGaps[0].exam_count} exam${recurringGaps[0].exam_count === 1 ? '' : 's'} with low scores. Rework the method, then solve a similar question without notes.`
        : 'Continue mixed practice across topics to consolidate reliable methods.',
    },
  };
}

/* Phase 5: resolve a legacy report username to the canonical student id via
 * credentials links, the students.user_id backfill, or report_versions. */
async function resolveStudentIdForUsername(db, username) {
  const linked = await db.execute({
    sql: 'SELECT sul.student_id FROM user_credentials uc JOIN student_user_links sul ON sul.user_id = uc.user_id WHERE uc.login_id = ? LIMIT 1',
    args: [username],
  });
  if (linked.rows[0]?.student_id) return linked.rows[0].student_id;
  const direct = await db.execute({
    sql: 'SELECT st.id FROM user_credentials uc JOIN students st ON st.user_id = uc.user_id WHERE uc.login_id = ? LIMIT 1',
    args: [username],
  });
  if (direct.rows[0]?.id) return direct.rows[0].id;
  const viaReport = await db.execute({
    sql: 'SELECT student_id FROM report_versions WHERE username = ? AND student_id IS NOT NULL ORDER BY published_at DESC LIMIT 1',
    args: [username],
  });
  return viaReport.rows[0]?.student_id || null;
}

/**
 * Refresh a single student's longitudinal DNA after a new report is published.
 * Reads all published reports, aggregates evidence, and upserts into learner_dna.
 */
export async function refreshLearnerDna(db, username) {
  const rows = (await db.execute({
    sql: `SELECT payload_json, school FROM report_versions WHERE username = ? AND status = 'published' ORDER BY published_at DESC`,
    args: [username],
  })).rows;

  if (!rows.length) return { skipped: true };

  const reports = rows.map((row) => JSON.parse(row.payload_json));
  const first = reports[0];
  const school = rows[0].school || first?.student?.school || '';
  const studentName = first?.student?.name || username;
  const className = first?.student?.class || '';

  // Generate DNA — returns null for single-exam students
  let dna = generateLongitudinalDna(reports);

  // For single-exam students, use the per-assessment DNA from the report
  if (!dna) {
    dna = first?.learner_dna || null;
    if (!dna) return { skipped: true };
  }

  const examCount = reports.length;
  const questionCount = (first?.term1?.subjects || []).reduce((s, subj) => s + (subj.questions || []).length, 0);
  const timestamp = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO learner_dna (username, school, student_name, class_name, dna_json, exam_count, question_count, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(username) DO UPDATE SET
            school = excluded.school,
            student_name = excluded.student_name,
            class_name = excluded.class_name,
            dna_json = excluded.dna_json,
            exam_count = excluded.exam_count,
            question_count = excluded.question_count,
            updated_at = excluded.updated_at`,
    args: [username, school, studentName, className, JSON.stringify(dna), examCount, questionCount, timestamp],
  });

  // Phase 5: the student_id-keyed DNA is the canonical "student brain" — one
  // row per student, immune to username/batch changes.
  try {
    const studentId = await resolveStudentIdForUsername(db, username);
    const schoolId = studentId
      ? (await db.execute({ sql: 'SELECT school_id FROM students WHERE id = ?', args: [studentId] })).rows[0]?.school_id || null
      : null;
    if (studentId && schoolId) {
      await db.execute({
        sql: `INSERT INTO learner_dna_v2 (student_id, school_id, dna_json, exam_count, question_count, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(student_id) DO UPDATE SET
                school_id = excluded.school_id, dna_json = excluded.dna_json,
                exam_count = excluded.exam_count, question_count = excluded.question_count, updated_at = excluded.updated_at`,
        args: [studentId, schoolId, JSON.stringify(dna), examCount, questionCount, timestamp, timestamp],
      });
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'canonical_mirror_failed', scope: 'learner_dna_v2', error: String(error?.message || error) }));
  }

  return { skipped: false, examCount, questionCount, scope: dna.assessment_scope?.level };
}
