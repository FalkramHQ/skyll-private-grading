// Role dashboards — student-facing screens and AdminDashboard re-export.
// AdminDashboard and its helpers were extracted to AdminDashboard.js.
// Shared components (Header, MathBody, AnswerSheetGallery) live in
// dashboardShared.js. Styles live in dashboardStyles.js.

import { useState, useEffect } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { dnaSummary, examScore, formatExamDate, getExamBundle } from './studentReportHelpers';
import { styles } from './dashboardStyles';
import { palette as colors } from './theme';
import { Header, MathBody, AnswerSheetGallery } from './dashboardShared';
import { recheckStatusLabel } from '@skyll/shared/workflowLifecycle.js';
import { RECHECK_REASON_MIN, RECHECK_REASON_MAX, normalizeRecheckReason } from './workflow';

export { AdminDashboard } from './AdminDashboard';

export function StudentDashboard({ context, onLogout, onOpenSubject, refreshing, onRefresh, onBack, onShareReport, sharing, onCheckUpdate, checkingUpdate, onProfile }) {
  const report = context?.report || {};
  const student = report.student || {};
  const exams = Array.isArray(report.exams) ? report.exams : [];
  const examKey = exams.map((exam) => exam.id).join('|');
  const [selectedExamId, setSelectedExamId] = useState(exams[0]?.id || '');

  useEffect(() => {
    if (!exams.length) {
      if (selectedExamId) setSelectedExamId('');
      return;
    }
    if (!exams.some((exam) => exam.id === selectedExamId)) {
      setSelectedExamId(exams[0].id);
    }
  }, [exams, examKey, selectedExamId]);

  const { subjects, selectedExam, insights } = getExamBundle(report, selectedExamId);
  const { score, total } = examScore(subjects);
  const dna = dnaSummary(report.learner_dna || report.learning_dna || {});
  const examDate = formatExamDate(selectedExam?.date);
  const focusNeeded = Array.isArray(insights?.focus_needed) ? insights.focus_needed.filter(Boolean) : [];
  const showAllAssessments = exams.length > 1;

  const percentage = total ? Math.round((score / total) * 100) : null;
  const scoreMeta = [examDate, subjects.length ? `${subjects.length} subject${subjects.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');

  return <ScrollView style={styles.page} contentContainerStyle={styles.content} refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} /> : undefined}>
    <Header school={student.school} name={student.name || 'My learning'} onLogout={onLogout} onBack={onBack} backLabel="Class insights" onRefresh={onRefresh} refreshing={refreshing} onProfile={onProfile} />

    {/* Tilted score card. One lime sticker carries the percentage. */}
    <View style={styles.scoreCard}>
      <Text style={styles.scoreMeta}>{scoreMeta || 'Your next report will appear here.'}</Text>
      <Text style={styles.scoreTitle}>{selectedExam?.name || 'Assessment overview'}</Text>
      <Text accessibilityLabel={`Score ${score} out of ${total}`} style={styles.scoreBig}>{score}<Text style={styles.scoreOutOf}>{`/${total}`}</Text></Text>
      <Text style={styles.scoreFoot}>{selectedExam ? 'This assessment' : 'Assessment score'}</Text>
      {percentage != null ? <View style={styles.sticker} accessibilityLabel={`${percentage} percent`}>
        <Text style={styles.stickerText}>{`${percentage}%`}</Text>
      </View> : null}
    </View>

    {showAllAssessments ? (
      <View style={[styles.card, styles.cardLoud]}>
        <Text style={styles.eyebrow}>Assessment history</Text>
        <Text style={styles.cardTitle}>{`${exams.length} published assessments`}</Text>
        <Text style={styles.body}>Select an assessment to view its score and subject breakdown.</Text>
        {exams.map((exam, index) => {
          const active = exam.id === selectedExamId;
          const bundle = getExamBundle(report, exam.id);
          const marks = examScore(bundle.subjects);
          return (
            <Pressable
              key={exam.id || exam.name || index}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${exam.name || `Assessment ${index + 1}`}, ${marks.score} of ${marks.total}${active ? ', selected' : ''}`}
              style={({ pressed }) => [styles.examRow, active && styles.examRowActive, pressed && styles.togglePressed]}
              onPress={() => setSelectedExamId(exam.id)}
            >
              <View style={styles.subjectCopy}>
                <Text style={styles.subjectTitle}>{exam.name || `Assessment ${index + 1}`}</Text>
                <Text style={styles.caption}>{[formatExamDate(exam.date), index === 0 ? 'Latest' : null].filter(Boolean).join(' · ')}</Text>
              </View>
              <View style={styles.subjectScore}>
                <Text style={styles.subjectScoreText}>{`${marks.score}/${marks.total}`}</Text>
                <Text style={active ? styles.linkOnLime : styles.link}>{active ? 'Selected' : 'View'}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    ) : null}

    {(insights?.strongest_area || focusNeeded.length) ? (
      <View style={[styles.card, styles.cardLoud]}>
        <Text style={styles.cardTitle}>Strengths & focus</Text>
        {insights?.strongest_area ? <StatusLine tone="positive" icon="✓" text={`Working strength: ${insights.strongest_area}`} /> : null}
        {focusNeeded.length ? <StatusLine tone="caution" icon="→" text={`Focus next: ${focusNeeded.join(', ')}`} /> : null}
        {insights?.pattern ? <Text style={styles.body}>{insights.pattern}</Text> : null}
      </View>
    ) : null}

    <View style={[styles.card, styles.cardLoud]}>
      <Text style={styles.eyebrow}>Learner DNA</Text>
      {dna.scope ? <Text style={styles.caption}>{dna.scope}</Text> : null}
      <Text style={styles.cardTitle}>{dna.title}</Text>
      <Text style={styles.body}>{dna.body}</Text>
      {dna.growth ? (
        <View style={styles.insightBlock}>
          <Text style={styles.nextLabel}>Growth edge</Text>
          <Text style={styles.nextText}>{dna.growth}</Text>
          {dna.growthAction ? <Text style={styles.body}>{dna.growthAction}</Text> : null}
        </View>
      ) : null}
      {dna.modes.length ? (
        <View style={styles.insightBlock}>
          <Text style={styles.nextLabel}>Observed learning modes</Text>
          {dna.modes.map((mode) => (
            <View key={mode.id || mode.label} style={styles.modeRow}>
              <Text style={styles.modeLabel}>{mode.label}</Text>
              <Text style={styles.modeState}>{mode.stateLabel}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {dna.next ? (
        <View style={styles.next}>
          {/* Second (and last) sticker on this screen. */}
          <View style={styles.stickerCoral}><Text style={styles.stickerCoralText}>{dna.nextTitle || 'Your next step'}</Text></View>
          <Text style={styles.nextText}>{dna.next}</Text>
        </View>
      ) : null}
      {onShareReport ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(sharing) }} disabled={sharing} style={({ pressed }) => [styles.secondaryButton, sharing && styles.disabled, pressed && styles.togglePressed]} onPress={onShareReport}><Text style={styles.secondaryButtonText}>{sharing ? 'Preparing PDF...' : 'Share report as PDF'}</Text></Pressable> : null}
    </View>

    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{selectedExam ? 'Subjects in this assessment' : 'Your subjects'}</Text>
    </View>
    {subjects.map((subject) => (
      <Pressable key={subject.id || subject.name} accessibilityRole="button" accessibilityLabel={`${subject.name}, ${subject.score ?? 0} of ${subject.total ?? 0}, open detailed report`} style={({ pressed }) => [styles.subjectCard, pressed && styles.subjectCardPressed]} onPress={() => onOpenSubject(subject, selectedExam)}>
        <View style={styles.subjectCopy}>
          <Text style={styles.subjectTitle}>{subject.name}</Text>
          <Text style={styles.caption}>{subject.questions?.length ? `${subject.questions.length} questions analysed` : 'Open detailed report'}</Text>
        </View>
        <View style={styles.subjectScore}>
          <Text style={styles.subjectScoreText}>{`${subject.score ?? 0}/${subject.total ?? 0}`}</Text>
          <Text style={styles.link}>View</Text>
        </View>
      </Pressable>
    ))}
    {!subjects.length ? <EmptyState title="No published reports yet" body="Your class administrator will publish results here after review is complete." /> : null}

    {onCheckUpdate ? (
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(checkingUpdate) }} disabled={checkingUpdate} style={({ pressed }) => [styles.secondaryButton, pressed && styles.togglePressed]} onPress={onCheckUpdate}>
        <Text style={styles.secondaryButtonText}>{checkingUpdate ? 'Checking for updates...' : 'Check for updates'}</Text>
      </Pressable>
    ) : null}
    <Text style={styles.footerNote}>AI Tutor, Learning Hive, practice tools, and revision plans are available on the Skyll web app for now.</Text>
  </ScrollView>;
}

// Status is never colour-only: an icon and the words always travel together.
const STATUS_TONE = {
  positive: { icon: styles.statusIconPositive, text: styles.statusTextPositive },
  caution: { icon: styles.statusIconCaution, text: styles.statusTextCaution },
};

function StatusLine({ tone, icon, text }) {
  const t = STATUS_TONE[tone] || STATUS_TONE.positive;
  return <View style={styles.statusLine}>
    <View style={[styles.statusIcon, t.icon]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Text style={styles.statusIconText}>{icon}</Text></View>
    <Text style={[styles.statusText, t.text]}>{text}</Text>
  </View>;
}

function EmptyState({ title, body }) {
  return <View style={[styles.empty, styles.emptyLoud]}>
    <View style={styles.emptySticker} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Text style={styles.emptyStickerText}>✓</Text></View>
    <Text style={styles.cardTitle}>{title}</Text>
    <Text style={styles.body}>{body}</Text>
  </View>;
}

// How clearly a question was answered, derived from marks. Never conveyed by
// colour alone — the label + icon text carry the meaning (WCAG-friendly).
function resultOf(question) {
  const obtained = Number(question.marks_obtained ?? question.marks ?? question.mark ?? 0) || 0;
  const total = Number(question.marks_total ?? question.allocated ?? question.max_marks ?? 0) || 0;
  if (!total) return { label: 'Not marked', tone: 'neutral', icon: '·' };
  if (obtained >= total) return { label: 'Correct', tone: 'correct', icon: '✓' };
  if (obtained > 0) return { label: 'Partial', tone: 'partial', icon: '◐' };
  return { label: 'Incorrect', tone: 'incorrect', icon: '✕' };
}

const RESULT_TONE = {
  correct: styles.resultCorrect,
  partial: styles.resultPartial,
  incorrect: styles.resultIncorrect,
  neutral: styles.resultNeutral,
};

const RESULT_SURFACE = {
  correct: styles.resultCorrectSurface,
  partial: styles.resultPartialSurface,
  incorrect: styles.resultIncorrectSurface,
  neutral: styles.resultNeutralSurface,
};

// Icon reinforces the recheck lifecycle stage, but the label text carries the
// meaning (never icon/colour alone — WCAG-friendly).
const RECHECK_ICON = { open: '⏳', in_review: '⏳', awaiting_regrade: '⏳', resolved: '✓', declined: '•', cancelled: '•' };

const LONG_TEXT_MIN = 90; // chars; below this the snippet is shown inline without a toggle

function QuestionCard({ question, onRequestRecheck, recheck, draft, onDraftChange }) {
  const [open, setOpen] = useState({}); // independent per-section expansion
  const [sending, setSending] = useState(false);
  const marks = `${Number(question.marks_obtained ?? question.marks ?? question.mark ?? 0) || 0}/${Number(question.marks_total ?? question.allocated ?? question.max_marks ?? 0) || 0}`;
  const explanation = question.what_went_correct || question.missing_or_wrong || question.grading_reason || question.diagnosis || '';
  const questionText = question.question || question.question_text || 'Question details are available in the full report.';
  const correctAnswer = question.correct_answer;
  const studentAnswer = question.student_answer;
  const result = resultOf(question);

  // Show the long sections inline when they are short — concise without any taps.
  const correctShort = correctAnswer && String(correctAnswer).length < LONG_TEXT_MIN;
  const studentShort = studentAnswer && String(studentAnswer).length < LONG_TEXT_MIN;
  const reasonShort = explanation && String(explanation).length < LONG_TEXT_MIN;

  const toggle = (section) => setOpen((current) => ({ ...current, [section]: !current[section] }));

  // Recheck note UX: mirror the server's 12-800 char rule live so the student
  // sees the requirement while typing instead of after a rejected submit. Send
  // stays disabled until the note is valid, and an in-flight flag blocks a
  // double-tap double-submit (the API 409s a duplicate active request).
  const reasonLength = normalizeRecheckReason(draft).length;
  const canSend = reasonLength >= RECHECK_REASON_MIN && reasonLength <= RECHECK_REASON_MAX;
  const reasonHint = canSend
    ? `${reasonLength}/${RECHECK_REASON_MAX} characters`
    : `${reasonLength}/${RECHECK_REASON_MIN} characters minimum`;
  const submitRecheck = async () => {
    if (sending || !canSend) return;
    setSending(true);
    try { await onRequestRecheck(question, draft || ''); } finally { setSending(false); }
  };

  return (
    <View style={styles.questionCard}>
      <View style={styles.questionHeader}>
        <Text style={styles.questionNumber}>{question.number || 'Question'}</Text>
        <View style={styles.questionMeta}>
          <Text style={[styles.questionMarks, result.tone === 'correct' && styles.questionMarksFull, result.tone === 'incorrect' && styles.questionMarksLow]}>{marks}</Text>
          <View accessibilityLabel={`Result: ${result.label}`} style={[styles.questionResult, RESULT_SURFACE[result.tone]]}>
            <Text style={[styles.questionResultText, RESULT_TONE[result.tone]]}>{`${result.icon} ${result.label}`}</Text>
          </View>
        </View>
      </View>
      <MathBody style={styles.questionText}>{questionText}</MathBody>

      {/* Concise results shown by default; long sections expand on demand. */}
      {correctShort ? <MathBody style={styles.answerText}>{`Correct answer: ${correctAnswer}`}</MathBody> : null}
      {studentShort ? <MathBody style={styles.answerText}>{`Your answer: ${studentAnswer}`}</MathBody> : null}
      {reasonShort ? <MathBody style={styles.body}>{explanation}</MathBody> : null}

      {(correctAnswer && !correctShort) || (studentAnswer && !studentShort) || (explanation && !reasonShort) ? (
        <View style={styles.toggleRow}>
          {correctAnswer && !correctShort ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: Boolean(open.correct) }}
              onPress={() => toggle('correct')}
              style={({ pressed }) => [styles.recheckButton, pressed && styles.togglePressed]}
            >
              <Text style={styles.recheckButtonText}>{open.correct ? 'Show less' : 'Show answer'}</Text>
            </Pressable>
          ) : null}
          {studentAnswer && !studentShort ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: Boolean(open.student) }}
              onPress={() => toggle('student')}
              style={({ pressed }) => [styles.recheckButton, pressed && styles.togglePressed]}
            >
              <Text style={styles.recheckButtonText}>{open.student ? 'Show less' : 'Show my answer'}</Text>
            </Pressable>
          ) : null}
          {explanation && !reasonShort ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: Boolean(open.reason) }}
              onPress={() => toggle('reason')}
              style={({ pressed }) => [styles.recheckButton, pressed && styles.togglePressed]}
            >
              <Text style={styles.recheckButtonText}>{open.reason ? 'Show less' : 'Show reasoning'}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {correctAnswer && !correctShort && open.correct ? (
        <View style={styles.questionSection}>
          <Text style={styles.questionSectionLabel}>Correct answer</Text>
          <MathBody style={styles.questionSectionBody}>{correctAnswer}</MathBody>
      </View>
      ) : null}
      {studentAnswer && !studentShort && open.student ? (
        <View style={styles.questionSection}>
          <Text style={styles.questionSectionLabel}>Your answer</Text>
          <MathBody style={styles.questionSectionBody}>{studentAnswer}</MathBody>
    </View>
      ) : null}
      {explanation && !reasonShort && open.reason ? (
        <View style={styles.questionSection}>
          <Text style={styles.questionSectionLabel}>Grading reasoning</Text>
          <MathBody style={styles.questionSectionBody}>{explanation}</MathBody>
              </View>
      ) : null}

      {recheck ? (
        <View style={styles.recheck}>
          <Text accessibilityRole="text" style={styles.recheckStatusLabel}>{`${RECHECK_ICON[recheck.status] || '•'} Recheck ${recheckStatusLabel(recheck.status)}`}</Text>
          {recheck.reason ? <Text style={styles.recheckStatusNote}>{`You asked: ${recheck.reason}`}</Text> : null}
          {recheck.resolutionNote ? <Text style={styles.recheckStatusNote}>{`Review note: ${recheck.resolutionNote}`}</Text> : null}
            </View>
      ) : onRequestRecheck ? (
        <View style={styles.recheck}>
          <Text style={styles.recheckLabel}>Need a recheck?</Text>
          <TextInput value={draft || ''} onChangeText={(value) => onDraftChange(value)} placeholder="Explain what should be rechecked" placeholderTextColor={colors.muted} multiline maxLength={RECHECK_REASON_MAX} style={styles.recheckInput} />
          <Text style={styles.recheckHint}>{reasonHint}</Text>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canSend || sending }} disabled={!canSend || sending} onPress={submitRecheck} style={[styles.recheckButton, (!canSend || sending) && styles.disabled]}><Text style={styles.recheckButtonText}>{sending ? 'Sending...' : 'Send recheck request'}</Text></Pressable>
      </View>
      ) : null}
    </View>
  );
}

export function StudentSubjectDashboard({ subject, studentName, school, onBack, onLogout, answerSheet, onRequestRecheck, rechecks, examName }) {
  const questions = subject?.questions || [];
  const [drafts, setDrafts] = useState({});
  const subjectScore = Number(subject?.score) || 0;
  const subjectTotal = Number(subject?.total) || 0;
  const subjectPercentage = subjectTotal ? Math.round((subjectScore / subjectTotal) * 100) : 0;
  return <ScrollView style={styles.page} contentContainerStyle={styles.content}>
    <Header school={school} name={subject?.name || 'Subject report'} onLogout={onLogout} onBack={onBack} backLabel="My report" />
    <View style={styles.scoreCard}>
      <Text style={styles.scoreMeta}>{examName || studentName || 'Student report'}</Text>
      <Text accessibilityLabel={`Score ${subjectScore} out of ${subjectTotal}`} style={styles.scoreBig}>{subjectScore}<Text style={styles.scoreOutOf}>{`/${subjectTotal}`}</Text></Text>
      <Text style={styles.scoreFoot}>{`${questions.length} question${questions.length === 1 ? '' : 's'} · score first, details on demand`}</Text>
      {subjectTotal ? <View style={styles.sticker} accessibilityLabel={`${subjectPercentage} percent`}>
        <Text style={styles.stickerText}>{`${subjectPercentage}%`}</Text>
      </View> : null}
    </View>
    {questions.map((question) => {
      const key = String(question.id || question.number || 'q');
      return (
        <QuestionCard
          key={key}
          question={question}
          onRequestRecheck={onRequestRecheck}
          recheck={rechecks?.[String(question.number ?? '')] || null}
          draft={drafts[key] || ''}
          onDraftChange={(value) => setDrafts((current) => ({ ...current, [key]: value }))}
        />
      );
    })}
    {answerSheet?.pages?.length ? <AnswerSheetGallery answerSheet={answerSheet} /> : null}
    {!questions.length ? <EmptyState title="Detailed analysis is not available yet" body="The score is published, but question-level feedback is still being prepared." /> : null}
  </ScrollView>;
}
