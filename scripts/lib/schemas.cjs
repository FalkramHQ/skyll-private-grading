function issue(path, message) {
  return { path, message };
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function questionsOf(examPlan) {
  return Array.isArray(examPlan) ? examPlan : examPlan?.questions;
}

function validateExamPlan(examPlan, { expectedTotal = null } = {}) {
  const issues = [];
  if (!isObject(examPlan) && !Array.isArray(examPlan)) {
    return [issue('$', 'exam_plan must be an object with questions[] or an array')];
  }
  const questions = questionsOf(examPlan);
  if (!Array.isArray(questions) || !questions.length) {
    issues.push(issue('questions', 'exam plan must contain at least one question'));
    return issues;
  }
  const seen = new Set();
  for (const [index, question] of questions.entries()) {
    const base = `questions[${index}]`;
    if (!question.question_number) issues.push(issue(`${base}.question_number`, 'missing question_number'));
    if (seen.has(question.question_number)) issues.push(issue(`${base}.question_number`, `duplicate question_number ${question.question_number}`));
    seen.add(question.question_number);
    if (!Number.isFinite(Number(question.marks_allocated))) issues.push(issue(`${base}.marks_allocated`, 'marks_allocated must be numeric'));
    if (!question.correct_answer_summary) issues.push(issue(`${base}.correct_answer_summary`, 'missing correct_answer_summary'));
    if (!question.marking_rubric) issues.push(issue(`${base}.marking_rubric`, 'missing marking_rubric'));
  }
  const rawTotal = questions.reduce((sum, question) => sum + Number(question.marks_allocated || 0), 0);
  if (expectedTotal != null && Number(expectedTotal) > 0) {
    const optionalGroups = examPlan.scoring_rules?.optional_groups || [];
    const scoreCaps = examPlan.scoring_rules?.score_caps || [];
    if (rawTotal !== Number(expectedTotal) && !optionalGroups.length && !scoreCaps.length) {
      issues.push(issue('questions', `raw mark total ${rawTotal} does not match expected ${expectedTotal} and no scoring rules exist`));
    }
  }
  return issues;
}

function validateStudentAnswers(answers, examPlan = null) {
  const issues = [];
  if (!Array.isArray(answers)) return [issue('$', 'student answers must be an array')];
  const seen = new Set();
  for (const [index, answer] of answers.entries()) {
    const base = `[${index}]`;
    if (!answer.question_number) issues.push(issue(`${base}.question_number`, 'missing question_number'));
    if (seen.has(answer.question_number)) issues.push(issue(`${base}.question_number`, `duplicate answer for ${answer.question_number}`));
    seen.add(answer.question_number);
    if (typeof answer.student_attempted !== 'boolean') issues.push(issue(`${base}.student_attempted`, 'student_attempted must be boolean'));
    if (answer.student_attempted && !String(answer.student_answer_raw || '').trim()) issues.push(issue(`${base}.student_answer_raw`, 'attempted answer has empty raw text'));
  }
  const questions = examPlan ? questionsOf(examPlan) || [] : [];
  if (questions.length && answers.length !== questions.length) {
    issues.push(issue('$', `answer count ${answers.length} does not match exam question count ${questions.length}`));
  }
  return issues;
}

function validateGradingData(data) {
  const issues = [];
  if (!isObject(data)) return [issue('$', 'grading_data must be an object')];
  if (!Array.isArray(data.gradedQuestions)) issues.push(issue('gradedQuestions', 'missing gradedQuestions array'));
  if (!Number.isFinite(Number(data.total))) issues.push(issue('total', 'missing numeric total'));
  if (!Number.isFinite(Number(data.max))) issues.push(issue('max', 'missing numeric max'));
  if (Array.isArray(data.gradedQuestions)) {
    const computedTotal = data.gradedQuestions
      .filter((question) => question.counts_toward_score !== false)
      .reduce((sum, question) => sum + Number(question.scored_marks_obtained ?? question.marks_obtained ?? 0), 0);
    const computedMax = data.gradedQuestions
      .filter((question) => question.counts_toward_score !== false)
      .reduce((sum, question) => sum + Number(question.scored_marks_allocated ?? question.marks_allocated ?? 0), 0);
    if (Math.abs(computedTotal - Number(data.total || 0)) > 0.001) {
      issues.push(issue('total', `stored total ${data.total} does not match question sum ${computedTotal}`));
    }
    if (Math.abs(computedMax - Number(data.max || 0)) > 0.001) {
      issues.push(issue('max', `stored max ${data.max} does not match question max sum ${computedMax}`));
    }
  }
  return issues;
}

function assertValid(label, issues) {
  if (issues.length) {
    const detail = issues.map((item) => `${item.path}: ${item.message}`).join('; ');
    throw new Error(`${label} validation failed: ${detail}`);
  }
}

module.exports = {
  assertValid,
  validateExamPlan,
  validateGradingData,
  validateStudentAnswers,
};
