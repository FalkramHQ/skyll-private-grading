// Native report → PDF for sharing.
// Renders the SAME published report payload shown in-app (passed by the caller)
// as a self-contained HTML string, then rasterizes it to a real PDF file via
// expo-print (bundled, OTA-safe: runs on device, no server, no new API route).
// Sharing back-compat: falls back to plain-text Share.share when PDF fails.

import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';
import { formatMathText } from './formatMathText';

// Strip characters that are unsafe in filenames on Android / most file systems.
export function safeFilename(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_\- ]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
    .trim();
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(obtained, total) {
  const o = Number(obtained) || 0;
  const t = Number(total) || 0;
  return t ? Math.round((o / t) * 100) : 0;
}

function rows(q) {
  const obt = Number(q.marks_obtained ?? q.marks ?? q.mark ?? 0) || 0;
  const tot = Number(q.marks_total ?? q.allocated ?? q.max_marks ?? 0) || 0;
  const label = !tot ? 'Not marked' : obt >= tot ? 'Correct' : obt > 0 ? 'Partial' : 'Incorrect';
  return {
    correct: q.correct_answer,
    student: q.student_answer,
    reason: q.what_went_correct || q.missing_or_wrong || q.grading_reason || q.diagnosis || '',
    label,
    pct: pct(obt, tot),
  };
}

// Build a print-ready HTML snapshot of the published in-app report.
export function reportToHtml(report = {}, opts = {}) {
  const student = report.student || {};
  const exams = Array.isArray(report.exams) ? report.exams : [];
  const selectedId = opts.examId || exams[0]?.id || '';
  const keyed = selectedId && report[selectedId] ? report[selectedId] : null;
  const bundle = keyed || report.term1 || {};
  const subjects = Array.isArray(bundle.subjects) ? bundle.subjects : Array.isArray(report.subjects) ? report.subjects : [];
  const selectedExam = exams.find((e) => e.id === selectedId) || exams[0] || null;

  const total = subjects.reduce((s, sub) => s + (Number(sub.total) || 0), 0);
  const score = subjects.reduce((s, sub) => s + (Number(sub.score) || 0), 0);

  const subjectHtml = subjects.map((subject) => {
    const questions = Array.isArray(subject.questions) ? subject.questions : [];
    const qHtml = questions.map((q, i) => {
      const { correct, student, reason, label } = rows(q);
      const obt = Number(q.marks_obtained ?? q.marks ?? q.mark ?? 0) || 0;
      const tot = Number(q.marks_total ?? q.allocated ?? q.max_marks ?? 0) || 0;
      const blocks = [];
      if (correct) blocks.push(`<p class="block"><span class="label">Correct answer</span><span class="val">${esc(formatMathText(correct))}</span></p>`);
      if (student) blocks.push(`<p class="block"><span class="label">Your answer</span><span class="val">${esc(formatMathText(student))}</span></p>`);
      if (reason) blocks.push(`<p class="block"><span class="label">Grading reasoning</span><span class="val">${esc(formatMathText(reason))}</span></p>`);
      return `
        <div class="question">
          <div class="qhead"><span class="qnum">Q${esc(q.number || i + 1)}</span>
            <span class="qmarks">${obt}/${tot}</span></div>
          <p class="qtext">${esc(formatMathText(q.question || q.question_text || ''))}</p>
          <p class="result ${label.toLowerCase().replace(/\s+/g, '')}">${label}</p>
          ${blocks.join('')}
        </div>`;
    }).join('');

    return `
      <section class="subject">
        <div class="subject-head"><h3>${esc(subject.name || 'Subject')}</h3><span class="smark">${subject.score ?? 0}/${subject.total ?? 0}</span></div>
        ${qHtml || '<p class="muted">No question-level detail in this published report.</p>'}
      </section>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a2e28; margin: 0; padding: 36px 40px; }
  .header { background: #022c22; color: #fff; border-radius: 12px; padding: 24px 28px; }
  .header .brand { color: #6ee7b7; font-size: 11px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }
  .header h1 { margin: 6px 0 0; font-size: 26px; }
  .header .sub { color: #a7dcca; font-size: 13px; margin-top: 6px; }
  .scoreline { display: flex; gap: 12px; align-items: center; margin-top: 14px; }
  .scoreline .big { font-size: 34px; font-weight: 800; color: #6ee7b7; }
  .scoreline .detail { color: #a7dcca; font-size: 13px; }
  .summary { display: flex; gap: 24px; margin: 22px 0 4px; flex-wrap: wrap; }
  .subject { margin-top: 22px; page-break-inside: avoid; }
  .subject-head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #059669; padding-bottom: 6px; margin-bottom: 10px; }
  .subject-head h3 { margin: 0; font-size: 18px; color: #022c22; }
  .smark { font-weight: 800; color: #059669; }
  .question { border: 1px solid #dde3df; border-left: 3px solid #059669; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .qhead { display: flex; justify-content: space-between; align-items: center; }
  .qnum { font-weight: 800; color: #022c22; }
  .qmarks { font-weight: 800; color: #059669; }
  .qtext { font-size: 13px; line-height: 1.5; color: #1a2e28; margin: 8px 0 4px; }
  .result { display: inline-block; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .4px; padding: 2px 8px; border-radius: 10px; }
  .result.correct { background: #d1fae5; color: #047857; }
  .result.partial { background: #fef3c7; color: #a86200; }
  .result.incorrect { background: #fee2e2; color: #b42318; }
  .result.notmarked { background: #eef2ef; color: #63736d; }
  .block { display: block; margin: 8px 0 0; border-top: 1px dashed #e5e7eb; padding-top: 6px; }
  .block .label { display: block; font-size: 10px; font-weight: 800; letter-spacing: .5px; text-transform: uppercase; color: #63736d; }
  .block .val { font-size: 13px; line-height: 1.5; color: #3f514b; }
  .footer { margin-top: 28px; font-size: 11px; color: #9ca3af; }
</style>
</head>
<body>
  <div class="header">
    <div class="brand">Skylight · Student learning report</div>
    <h1>${esc(student.name || 'Student learning report')}</h1>
    <div class="sub">${esc(student.school || '')}${selectedExam?.name ? ' · ' + esc(selectedExam.name) : ''}</div>
    <div class="scoreline"><span class="big">${pct(score, total)}%</span><span class="detail">${score}/${total} marks${subjects.length ? ' · ' + subjects.length + ' subject' + (subjects.length === 1 ? '' : 's') : ''}</span></div>
  </div>
  ${subjectHtml || '<p class="muted">No published report detail to show.</p>'}
  <div class="footer">Generated by Skyll · https://www.skyllai.com</div>
</body>
</html>`;
}

// Generate a PDF file on disk from the published report and return its URI.
export async function makeReportPdf(report = {}, opts = {}) {
  const html = reportToHtml(report, opts);
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}

// Share the report: prefer a PDF attachment, fall back to plain text.
// Reports shareable via WhatsApp, Drive, email and file-save on Android's
// share sheet (expo-sharing). Errors are recoverable and reported to the caller.
function plainTextSummary(report = {}) {
  const bundle = report.term1 || {};
  const subjects = bundle.subjects || report.subjects || [];
  const lines = subjects.map((item) => `${item.name}: ${item.score ?? 0}/${item.total ?? 0}`);
  return {
    title: 'My Skyll report',
    message: `${report.student?.name || 'Student'}'s Skyll report\n${lines.join('\n')}`,
  };
}

export async function shareReportPdf(report = {}, opts = {}) {
  try {
    const uri = await makeReportPdf(report, opts);
    if (uri && (await Sharing.isAvailableAsync())) {
      const student = report.student || {};
      const exam = Array.isArray(report.exams) ? report.exams.find((e) => e.id === (opts.examId || '')) || report.exams[0] : null;
      const namePart = safeFilename(student.name || 'Student');
      const examPart = safeFilename(exam?.name || 'Report');
      const filename = `${namePart}_${examPart}_Report.pdf`;
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Share Skyll report', UTI: 'com.adobe.pdf' });
      return { ok: true, mode: 'pdf', filename };
    }
    throw new Error('PDF sharing is not available on this device');
  } catch (error) {
    // Fallback: plain-text share so sharing is never lost entirely.
    try {
      await Share.share(plainTextSummary(report));
      return { ok: true, mode: 'text', fallback: true };
    } catch {
      return { ok: false, mode: 'text', fallback: true, error };
    }
  }
}
