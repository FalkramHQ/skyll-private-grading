import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download } from 'lucide-react';
import MathText from '../components/MathText';
import AnswerSheetGallery from '../components/AnswerSheetGallery';
import SubPartBreakdown from '../components/SubPartBreakdown';
import { getCurrentExamData, loadStudentData } from '../data/studentData';
import { createStudentReportView } from '../lib/reportViewModel';
import { getReportBackUrl } from '../lib/reportNavigation';
import { formatReportText } from '../lib/textFormat';
import { toStudentFacingText } from '../lib/studentFacingText';
import ReportOutline from '../components/ReportOutline';

// Status is carried by words; colour only confirms it. Never a label about the student.
const statusLabels = {
  strong: 'Going well',
  needs_improvement: 'Getting there',
  critical: 'Practise next'
};

const statusBadge = {
  strong: { bg: 'var(--success-soft)', color: 'var(--success-soft-foreground)' },
  needs_improvement: { bg: 'var(--info-soft)', color: 'var(--info)' },
  critical: { bg: 'var(--warning-soft)', color: 'var(--warning-soft-foreground)' }
};

const INK = 'var(--ink)';
const TEXT_2 = 'var(--foreground-secondary)';
const CAPTION = 'var(--muted-foreground)';
const HAIRLINE = 'var(--hairline)';
const DISPLAY = 'var(--font-headline)';

// Question outcome chips: full marks are success green, never blue.
const outcomeStyle = (got, total) => {
  if (total > 0 && got >= total) return { bg: 'var(--success-soft)', color: 'var(--success-soft-foreground)', label: 'Full marks', mark: '✓' };
  if (got > 0) return { bg: 'var(--warning-soft)', color: 'var(--warning-soft-foreground)', label: 'Part marks', mark: '◐' };
  return { bg: 'var(--sunken)', color: TEXT_2, label: 'No marks', mark: '○' };
};

const labelStyle = { fontSize: 12, fontWeight: 700, color: TEXT_2, letterSpacing: '0.02em', margin: '0 0 4px' };
const eyebrowStyle = { fontSize: 12, fontWeight: 700, color: TEXT_2, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px' };

function SkyllMark({ size = 32 }) {
  return (
    <span aria-hidden="true" style={{ display: 'inline-grid', placeItems: 'center', width: size, height: size, overflow: 'hidden', flexShrink: 0 }}>
      <img src="/skyll-logo.svg" alt="" style={{ width: size, height: size, objectFit: 'contain', transform: 'scale(1.7)' }} />
    </span>
  );
}

const gradeLetter = (pct) => {
  if (pct >= 90) return { letter: 'A', color: 'var(--success-soft-foreground)', bg: 'var(--success-soft)' };
  if (pct >= 80) return { letter: 'B', color: 'var(--success-soft-foreground)', bg: 'var(--success-soft)' };
  if (pct >= 70) return { letter: 'C', color: 'var(--info)', bg: 'var(--info-soft)' };
  if (pct >= 50) return { letter: 'D', color: 'var(--warning-soft-foreground)', bg: 'var(--warning-soft)' };
  return { letter: 'E', color: 'var(--warning-soft-foreground)', bg: 'var(--warning-soft)' };
};

function ScoreBar({ pct, width = '100%', height = 8 }) {
  return (
    <div style={{ height, width, maxWidth: '100%', background: 'var(--sunken)', border: `1.5px solid ${INK}`, borderRadius: 99, overflow: 'hidden' }}>
      {/* Score bars are data, not status: one sequential tone (seq-3) with an ink outline. */}
      <div className="bg-seq-3" style={{ height: '100%', width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function cleanReportText(text) {
  return text ? formatReportText(toStudentFacingText(text)) : '';
}

const REPORT_SECTIONS = [
  { id: 'result', label: 'Assessment Result', nextAction: 'Review weak areas' },
  { id: 'subjects', label: 'Subject Performance', nextAction: null },
  { id: 'dna', label: 'Learner DNA', nextAction: null },
  { id: 'questions', label: 'Question Analysis', nextAction: null },
  { id: 'answer-sheets', label: 'Answer Sheets', nextAction: null },
];

export default function Report() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const examId = searchParams.get('exam') || 'term1';
  const requestedStudentUsername = searchParams.get('student') || '';
  const [isHydrating, setIsHydrating] = useState(() => Boolean(requestedStudentUsername && !getCurrentExamData(examId)));
  const [loadError, setLoadError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const data = createStudentReportView(getCurrentExamData(examId));
  const reportStudentUsername = requestedStudentUsername || data?.username || '';
  const [activeSection, setActiveSection] = useState('result');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        }
      },
      { rootMargin: '-20% 0px -60% 0px' },
    );
    REPORT_SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [data]);

  useEffect(() => {
    if (!requestedStudentUsername || getCurrentExamData(examId)) {
      setIsHydrating(false);
      return undefined;
    }
    let active = true;
    loadStudentData(requestedStudentUsername)
      .then(() => { if (active) setLoadError(''); })
      .catch((error) => { if (active) setLoadError(error.message || 'Could not load this report.'); })
      .finally(() => { if (active) setIsHydrating(false); });
    return () => { active = false; };
  }, [examId, requestedStudentUsername]);

  if (isHydrating) {
    return <div className="notebook-grid flex min-h-screen items-center justify-center"><p className="rounded-full border-2 border-ink bg-card px-4 py-2 text-sm font-semibold text-foreground">Loading report...</p></div>;
  }

  const handleDownload = async () => {
    const element = document.getElementById('report-content');
    if (!element) return;
    setDownloadError('');
    try {
    const filename = `${name.replace(/\s+/g, '_')}_${examInfo?.name?.replace(/\s+/g, '_') || 'Report'}_Report.pdf`;
    const { default: html2pdf } = await import('html2pdf.js');
    // Force desktop width in html2canvas's clone. Do not park a fixed/absolute
    // off-screen node - html2canvas captures those as blank white pages.
    await document.fonts?.ready;
    await Promise.all([...element.querySelectorAll('img')].map((image) => (
      image.complete ? Promise.resolve() : new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      })
    )));
    window.scrollTo(0, 0);
    await html2pdf()
      .set({
        margin: [10, 0, 10, 0],
        filename,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: false,
          windowWidth: 800,
          scrollX: 0,
          scrollY: -window.scrollY,
          onclone: (clonedDoc) => {
            // Phone downloads should still render the desktop report layout.
            // Neutralize the page's max-width:640px rules inside the capture clone.
            const override = clonedDoc.createElement('style');
            override.textContent = `
              html, body { width: 800px !important; min-width: 800px !important; margin: 0 !important; background: #fff !important; }
              .report { width: 800px !important; min-width: 800px !important; max-width: none !important; margin: 0 !important; padding-top: 0 !important; background: #fff !important; overflow-x: visible !important; }
              .report-score-card { transform: none !important; }
            `;
            clonedDoc.head.appendChild(override);
            const cloned = clonedDoc.getElementById('report-content');
            if (!cloned) return;
            cloned.style.width = '800px';
            cloned.style.minWidth = '800px';
            cloned.style.maxWidth = 'none';
            cloned.style.margin = '0';
            cloned.style.paddingTop = '0';
            cloned.style.background = '#fff';
            cloned.querySelectorAll('.no-print').forEach((node) => node.remove());
          },
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
      })
      .from(element)
      .save();
    } catch (error) {
      setDownloadError(error.message || 'Could not download this report.');
    }
  };

  const handleBack = () => {
    navigate(getReportBackUrl(searchParams));
  };

  if (!data) {
    return (
      <div className="notebook-grid flex min-h-screen items-center justify-center px-4">
        <div className="max-w-sm rounded-[20px] border-2 border-ink bg-card px-6 py-8 text-center shadow-hard-lg">
          <h2 className="mb-4 text-xl text-foreground">{loadError || 'No report data found'}</h2>
          <button onClick={handleBack} className="inline-flex h-11 items-center rounded-xl border-2 border-ink bg-card px-5 text-sm text-foreground hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  const { name, roll_number, class: studentClass, school, examInfo, subjects = [], overall_insights = {}, learning_diagnosis = {}, workflow = {} } = data;
  const totalScore = (subjects || []).reduce((sum, subject) => sum + (Number(subject.score) || 0), 0);
  const totalAvailable = (subjects || []).reduce((sum, subject) => sum + (Number(subject.total) || 0), 0);
  const overallPct = totalAvailable ? Math.round((totalScore / totalAvailable) * 100) : 0;
  const overallGrade = gradeLetter(overallPct);
  const overallStatus = overallPct >= 75 ? 'Going well' : overallPct >= 45 ? 'Getting there' : 'Practise next';
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <>
      <style>{`
        @media print {
          @page { size: A4; margin: 10mm 0; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
          .no-print { display: none !important; }
          .avoid-break { break-inside: avoid; }
          .report { padding-top: 0 !important; }
          .report-score-card { transform: none !important; }
          .report-pill { background: #fff !important; }
        }
        .report * { box-sizing: border-box; }
        .report { font-family: var(--font-body, 'Instrument Sans Variable'), 'Helvetica Neue', Arial, sans-serif; color: #111111; line-height: 1.5; }
        .report h1, .report h2, .report h3, .report .report-display { font-family: var(--font-headline, 'Bricolage Grotesque Variable'), 'Helvetica Neue', Arial, sans-serif; }
        .report .report-num { font-family: var(--font-headline, 'Bricolage Grotesque Variable'), 'Helvetica Neue', Arial, sans-serif; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: -0.03em; }
        .markdown-content p { margin: 0 0 6px; }
        .markdown-content p:last-child { margin-bottom: 0; }
        .markdown-content ul { margin: 0 0 6px; padding-left: 18px; }
        .markdown-content li { margin-bottom: 2px; }
        .subject-section { break-inside: avoid-page; }
        .page-break { break-before: page; }
        .subject-overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
        .report-toolbar button:focus-visible { outline: none; box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--ring); }
        @media (max-width: 640px) {
          .report { max-width: 100% !important; overflow-x: hidden; }
          .report-toolbar { padding: 8px 12px !important; }
          .report-toolbar button { padding: 0 12px !important; font-size: 13px !important; }
          .report-header { padding: 24px 18px 28px !important; }
          .report-header-grid { grid-template-columns: 1fr !important; gap: 22px !important; }
          .report-score-card { min-width: 0 !important; }
          .report-info { padding: 16px 16px 0 !important; }
          .report-info .avoid-break { padding: 14px !important; }
          .report-subject-overview, .report-learning-pattern { padding: 20px 16px 0 !important; }
          .subject-section, .report-answer-sheets { padding: 0 16px !important; }
          .subject-section .avoid-break[style*="display: flex"] { flex-wrap: wrap; gap: 10px; }
          .subject-overview-grid { grid-template-columns: 1fr; }
          .section-breakdown-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .report .no-print { margin: 32px 16px 0 !important; }
          .report-footer { margin: 32px 16px 0 !important; flex-direction: column; align-items: flex-start !important; gap: 8px; }
          .report-disclaimer { padding: 0 16px 32px !important; }
        }
      `}</style>

      {/* Report navigation outline (desktop only, excluded from print) */}
      <div className="no-print hidden md:block" style={{ position: 'fixed', left: 'calc(50% - 432px)', top: 80, width: 180, zIndex: 100 }}>
        <ReportOutline
          sections={REPORT_SECTIONS}
          activeId={activeSection}
          onSelect={(id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })}
        />
      </div>

      {/* Toolbar */}
      <div className="no-print report-toolbar" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 999, background: 'var(--paper)', borderBottom: `2px solid ${INK}`, padding: '10px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <button onClick={handleBack} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, padding: '0 16px', fontSize: 14, fontWeight: 600, color: INK, background: '#fff', border: `2px solid ${INK}`, borderRadius: 12, cursor: 'pointer' }}>
          <ArrowLeft size={16} aria-hidden="true" /> Back to Dashboard
        </button>
        <button onClick={handleDownload} className="press" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, padding: '0 18px', fontSize: 14, fontWeight: 700, color: '#fff', background: 'var(--action)', border: `2px solid ${INK}`, borderRadius: 12, cursor: 'pointer', boxShadow: `3px 3px 0 ${INK}` }}>
          <Download size={16} aria-hidden="true" /> Download PDF
        </button>
      </div>
      {downloadError ? <p className="no-print" role="alert" style={{ textAlign: 'center', color: 'var(--destructive)', fontSize: 13, fontWeight: 600, margin: '76px 16px 0' }}>{downloadError}</p> : null}

      {/* Report */}
      <div id="report-content" className="report" style={{ background: '#fff', maxWidth: 800, width: '100%', margin: '0 auto', paddingTop: 66 }}>

        {/* ── HEADER ── */}
        <div className="report-header" style={{ background: '#fff', borderBottom: `2px solid ${INK}`, padding: '30px 48px 34px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 26 }}>
            <SkyllMark size={32} />
            <div>
              <p className="report-display" style={{ color: INK, fontWeight: 800, fontSize: 16, letterSpacing: '-0.01em', margin: 0, lineHeight: 1.1 }}>Skyll</p>
              <p style={{ color: TEXT_2, fontWeight: 600, fontSize: 12, margin: '2px 0 0' }}>Student learning report</p>
            </div>
          </div>
          <div className="report-header-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 32 }}>
            <div style={{ minWidth: 0 }}>
              <p className="report-pill" style={{ display: 'inline-block', background: 'var(--lime)', color: INK, border: `1.5px solid ${INK}`, borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700, margin: '0 0 12px' }}>Assessment reflection</p>
              <h1 style={{ color: INK, fontSize: 34, fontWeight: 800, letterSpacing: '-0.03em', margin: '0 0 10px', lineHeight: 1.05 }}>Your learning report</h1>
              <p style={{ color: INK, fontSize: 15, fontWeight: 600, margin: '0 0 4px', lineHeight: 1.45 }}>{examInfo?.name || 'Assessment'}{examInfo?.date ? ` · ${examInfo.date}` : ''}</p>
              <p style={{ color: CAPTION, fontSize: 13, margin: 0 }}>Prepared for {name} · Generated {today}</p>
            </div>
            <div className="report-score-card" style={{ position: 'relative', minWidth: 220, background: '#fff', border: `2px solid ${INK}`, borderRadius: 20, boxShadow: `5px 5px 0 ${INK}`, padding: '20px 22px 18px', transform: 'rotate(-2deg)' }}>
              <span aria-hidden="true" style={{ position: 'absolute', top: -12, left: '50%', width: 88, height: 22, marginLeft: -44, background: 'var(--lime)', border: `1.5px solid ${INK}`, transform: 'rotate(3deg)' }} />
              <p style={{ color: TEXT_2, fontSize: 12, fontWeight: 700, margin: '0 0 4px' }}>Overall performance</p>
              <p className="report-num" style={{ color: INK, margin: 0, lineHeight: 0.9 }}>
                <span style={{ fontSize: 56 }}>{totalScore}</span>
                <span style={{ fontSize: 22, color: TEXT_2 }}>/{totalAvailable}</span>
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <span style={{ color: INK, fontSize: 14, fontWeight: 700 }}>{overallPct}% of marks</span>
                <span style={{ display: 'inline-grid', placeItems: 'center', minWidth: 26, height: 26, padding: '0 6px', borderRadius: 999, background: overallGrade.bg, color: overallGrade.color, fontSize: 13, fontWeight: 800 }}>{overallGrade.letter}</span>
              </div>
              <p style={{ color: TEXT_2, fontSize: 13, fontWeight: 600, margin: '4px 0 0' }}>{overallStatus}</p>
            </div>
          </div>
        </div>

        {/* ── STUDENT INFO ── */}
        <div id="result" className="report-info" style={{ padding: '24px 48px 0' }}>
          <div className="avoid-break" style={{ border: `1.5px solid ${INK}`, borderRadius: 14, padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10, background: '#fff' }}>
            <div>
              <h2 style={{ fontSize: 21, fontWeight: 700, color: INK, margin: '0 0 4px' }}>{name}</h2>
              <p style={{ fontSize: 13, color: TEXT_2, margin: 0 }}>Class <strong style={{ color: INK }}>{studentClass}</strong>{roll_number ? <> &nbsp;·&nbsp; Roll No. <strong style={{ color: INK }}>{roll_number}</strong></> : null}</p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: 13, color: TEXT_2, margin: 0 }}>{school}</p>
            </div>
          </div>
        </div>

        {/* ── SUBJECT TABLE ── */}
        <div id="subjects" className="report-subject-overview" style={{ padding: '24px 48px 0' }}>
          <p style={eyebrowStyle}>Subject overview</p>
          <div className="subject-overview-grid">
            {(subjects || []).map((subject) => {
              const pct = Math.round(((subject.score || 0) / (subject.total || 1)) * 100);
              const badge = statusBadge[subject.status] || statusBadge.needs_improvement;
              return <article key={subject.id || subject.name} className="avoid-break" style={{ border: `1.5px solid ${INK}`, borderRadius: 14, padding: '14px 16px', background: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <p className="report-display" style={{ fontSize: 17, fontWeight: 700, color: INK, margin: 0, lineHeight: 1.2 }}>{subject.name}</p>
                  <span style={{ display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: badge.bg, color: badge.color, whiteSpace: 'nowrap' }}>{statusLabels[subject.status] || statusLabels.needs_improvement}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginTop: 16 }}>
                  <p className="report-num" style={{ margin: 0, color: INK, lineHeight: 1 }}><span style={{ fontSize: 30 }}>{subject.score}</span><span style={{ color: TEXT_2, fontSize: 15 }}>/{subject.total}</span></p>
                  <span style={{ color: TEXT_2, fontSize: 14, fontWeight: 700 }}>{pct}%</span>
                </div>
                <div style={{ marginTop: 10 }}><ScoreBar pct={pct} /></div>
              </article>;
            })}
          </div>
        </div>

        {/* ── LEARNING PATTERN ── */}
        <div id="dna" className="report-learning-pattern" style={{ padding: '20px 48px 0' }}>
          <div className="avoid-break" style={{ background: 'var(--paper)', borderRadius: 14, padding: '14px 18px' }}>
            <p style={labelStyle}>Learning pattern</p>
            <div className="markdown-content" style={{ fontSize: 14, color: INK, margin: 0, lineHeight: 1.55 }}>
              <MathText text={cleanReportText(overall_insights?.pattern || '')} stripJargon={false} block />
            </div>
          </div>
        </div>

        {learning_diagnosis.headline && (
          <div className="report-learning-pattern" style={{ padding: '20px 48px 0' }}>
            <div className="avoid-break" style={{ border: `1.5px solid ${INK}`, borderRadius: 14, padding: '16px 18px', background: '#fff' }}>
              <p style={labelStyle}>Learning diagnosis</p>
              <p className="report-display" style={{ fontSize: 18, fontWeight: 700, color: INK, margin: '0 0 6px', lineHeight: 1.25 }}>{learning_diagnosis.headline}</p>
              <p style={{ fontSize: 13, color: TEXT_2, margin: '0 0 8px', lineHeight: 1.55 }}>{learning_diagnosis.score_effect}</p>
              {(learning_diagnosis.patterns || []).map((pattern) => <div key={pattern.title} style={{ borderTop: `1px solid ${HAIRLINE}`, paddingTop: 10, marginTop: 10 }}><p style={{ fontSize: 14, fontWeight: 700, color: INK, margin: 0 }}>{pattern.title}</p><p style={{ fontSize: 13, color: TEXT_2, margin: '3px 0 0', lineHeight: 1.55 }}>{pattern.detail}</p><p style={{ fontSize: 13, color: INK, margin: '6px 0 0', lineHeight: 1.55 }}><strong>Next diagnostic move:</strong> {pattern.next_step}</p></div>)}
              {learning_diagnosis.attempt_signal && <p style={{ fontSize: 12, color: CAPTION, margin: '10px 0 0', lineHeight: 1.45 }}>{learning_diagnosis.attempt_signal}</p>}
            </div>
          </div>
        )}

        {/* ═══════════ SUBJECTS - CONTINUOUS FLOW ═══════════ */}
        <div id="questions">
        {(subjects || []).map((s, sIdx) => {
          const has = (arr) => arr && arr.length > 0;
          if (!has(s.strengths) && !has(s.misconceptions) && !s.root_cause && !has(s.recommendations)) return null;
          const pct = Math.round(((s.score || 0) / (s.total || 1)) * 100);
          const g = gradeLetter(pct);

          return (
            <div key={s.id} className="subject-section" style={{ padding: '0 48px' }}>

              {/* Subject divider */}
              <div className="avoid-break" style={{ marginTop: sIdx === 0 ? 32 : 40, marginBottom: 20, borderTop: `2px solid ${INK}`, paddingTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ ...eyebrowStyle, margin: '0 0 4px' }}>Detailed feedback</p>
                  <h2 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, lineHeight: 1.1 }}>{s.name}</h2>
                  <div style={{ marginTop: 10 }}><ScoreBar pct={pct} width={200} height={8} /></div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                    <span className="report-num" style={{ color: INK, lineHeight: 1 }}><span style={{ fontSize: 30 }}>{s.score}</span><span style={{ fontSize: 16, color: TEXT_2 }}>/{s.total}</span></span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 28, height: 28, padding: '0 6px', borderRadius: 999, background: g.bg, color: g.color, fontSize: 13, fontWeight: 800 }}>{g.letter}</span>
                  </div>
                  <p style={{ fontSize: 13, color: TEXT_2, margin: '4px 0 0' }}>{pct}% · {statusLabels[s.status] || statusLabels.needs_improvement}</p>
                </div>
              </div>

              {/* Core Strength */}
              {s.learning_profile?.core_strength && (
                <div className="avoid-break" style={{ background: 'var(--success-soft)', borderLeft: '3px solid var(--success)', borderRadius: '0 10px 10px 0', padding: '12px 16px', marginBottom: 16 }}>
                  <p style={{ ...labelStyle, color: 'var(--success-soft-foreground)' }}>Core strength</p>
                  <div className="markdown-content" style={{ fontSize: 14, color: INK, margin: 0, lineHeight: 1.55 }}>
                    <MathText text={cleanReportText(s.learning_profile.core_strength)} stripJargon={false} block />
                  </div>
                </div>
              )}

              {/* Pattern We Noticed */}
              {(s.learning_profile?.pattern_recognition || s.root_cause) && (
                <div className="avoid-break" style={{ background: 'var(--paper)', borderLeft: `3px solid ${INK}`, borderRadius: '0 10px 10px 0', padding: '12px 16px', marginBottom: 16 }}>
                  <p style={labelStyle}>Pattern we noticed</p>
                  <div className="markdown-content" style={{ fontSize: 14, color: INK, margin: 0, lineHeight: 1.55 }}>
                    <MathText text={cleanReportText(s.learning_profile?.pattern_recognition || s.root_cause)} stripJargon={false} block />
                  </div>
                </div>
              )}

              {/* What To Do Next */}
              {(s.learning_profile?.strategies?.length > 0 || s.recommendations?.length > 0) && (
                <div className="avoid-break" style={{ marginBottom: 16 }}>
                  <p className="report-pill" style={{ display: 'inline-block', background: 'var(--lime)', color: INK, border: `1.5px solid ${INK}`, borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 700, margin: '0 0 10px' }}>What to do next</p>
                  {(s.learning_profile?.strategies?.length > 0
                    ? s.learning_profile.strategies
                    : s.recommendations || []
                  ).map((strat, i) => (
                    <div key={i} className="avoid-break" style={{ border: `1.5px solid ${INK}`, borderRadius: 12, padding: '12px 14px', marginBottom: 8 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: INK, margin: '0 0 3px' }}><MathText text={strat.topic || strat.title} stripJargon={false} /></div>
                      {strat.challenge && <div className="markdown-content" style={{ fontSize: 13, color: TEXT_2, margin: '0 0 3px' }}><MathText text={cleanReportText(strat.challenge)} stripJargon={false} block /></div>}
                      <div className="markdown-content" style={{ fontSize: 13, color: TEXT_2, margin: 0 }}><MathText text={cleanReportText(strat.strategy || strat.action)} stripJargon={false} block /></div>
                    </div>
                  ))}
                </div>
              )}

              {/* Sections */}
              {has(s.sections) && (
                <div style={{ marginBottom: 20 }}>
                  <p style={eyebrowStyle}>Section breakdown</p>
                  <div className="section-breakdown-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${(s.sections || []).length}, minmax(0, 1fr))`, gap: 8 }}>
                    {(s.sections || []).map((sec, i) => {
                      const sp = Math.round(((sec.score || 0) / (sec.total || 1)) * 100);
                      return (
                        <div key={i} className="avoid-break" style={{ border: `1px solid ${HAIRLINE}`, borderRadius: 12, padding: '10px 12px' }}>
                          <p style={{ fontSize: 12, fontWeight: 700, color: INK, margin: '0 0 6px' }}>{sec.name}</p>
                          <p className="report-num" style={{ margin: '0 0 8px', color: INK, lineHeight: 1 }}>
                            <span style={{ fontSize: 22 }}>{sec.score}</span>
                            <span style={{ fontSize: 13, color: TEXT_2 }}>/{sec.total}</span>
                          </p>
                          <ScoreBar pct={sp} height={6} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Misconceptions */}
              {has(s.misconceptions) && (
                <div style={{ marginBottom: 20 }}>
                  <h3 style={{ fontSize: 17, fontWeight: 700, color: INK, margin: '0 0 10px' }}>Needs attention</h3>
                  {(s.misconceptions || []).map((m, i) => (
                    <div key={i} className="avoid-break" style={{ background: 'var(--warning-soft)', borderLeft: '3px solid var(--warning)', borderRadius: '0 10px 10px 0', padding: '12px 14px', marginBottom: 8 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: INK, margin: '0 0 8px' }}><MathText text={m.issue} stripJargon={false} /></div>
                      <div style={{ marginBottom: 6 }}>
                        <p style={labelStyle}>What happened</p>
                        <div className="markdown-content" style={{ fontSize: 13, color: INK, margin: 0 }}><MathText text={cleanReportText(m.what_student_did || '')} stripJargon={false} block /></div>
                      </div>
                      <div style={{ marginBottom: m.what_this_means ? 6 : 0 }}>
                        <p style={labelStyle}>What this means</p>
                        <div className="markdown-content" style={{ fontSize: 13, color: INK, margin: 0 }}><MathText text={cleanReportText(m.what_this_means || '')} stripJargon={false} block /></div>
                      </div>
                      {m.impact && (
                        <div>
                          <p style={labelStyle}>Impact</p>
                          <div className="markdown-content" style={{ fontSize: 13, color: INK, margin: 0 }}><MathText text={cleanReportText(m.impact)} stripJargon={false} block /></div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Question-by-question */}
              {has(s.questions) && (
                <div style={{ marginBottom: 20 }}>
                  <h3 style={{ fontSize: 17, fontWeight: 700, color: INK, margin: '0 0 10px' }}>Question-by-Question</h3>
                  {s.questions.map((q, qi) => {
                    const ok = q.status === 'correct';
                    const outcome = outcomeStyle(Number(q.marks_obtained), Number(q.marks_total));
                    return (
                      <div key={qi} className="avoid-break" style={{ border: `1px solid ${HAIRLINE}`, borderRadius: 12, padding: '12px 14px', marginBottom: 8 }}>
                        {/* Header */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          <span aria-hidden="true" style={{ display: 'inline-grid', placeItems: 'center', width: 20, height: 20, borderRadius: 999, background: outcome.bg, color: outcome.color, fontSize: 12, fontWeight: 800, flexShrink: 0 }}>{outcome.mark}</span>
                          <span style={{ fontSize: 14, fontWeight: 700, color: INK }}>{q.number}</span>
                          <span style={{ fontSize: 13, color: TEXT_2, flex: 1, minWidth: 0 }}><MathText text={q.summary} stripJargon={false} /></span>
                          <span className="report-num" style={{ fontSize: 14, color: outcome.color, background: outcome.bg, border: `1.5px solid ${INK}`, padding: '1px 9px', borderRadius: 999, letterSpacing: 0, flexShrink: 0 }} title={outcome.label}>{q.marks_obtained}/{q.marks_total}</span>
                        </div>

                        {/* Question Text */}
                        {(q.question || q.question_text) && (
                          <div style={{ background: 'var(--color-paper-soft, #FAF8F2)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
                            <p style={labelStyle}>Question</p>
                            <div className="markdown-content" style={{ fontSize: 13, color: INK, margin: 0 }}>
                              <MathText text={q.question || q.question_text || ''} stripJargon={false} block />
                            </div>
                            {q.mcq_option_map && Object.keys(q.mcq_option_map).length > 0 && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                                {Object.entries(q.mcq_option_map).map(([letter, text]) => (
                                  <span key={letter} style={{ fontSize: 12, padding: '2px 6px', borderRadius: 6, background: '#fff', border: `1px solid ${HAIRLINE}` }}>
                                    <strong>({letter})</strong> {text}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Structured sub-parts: one readable row per sub-part when
                            canonical structured data exists. Row marks sum to the
                            overall question total shown in the header chip. State is
                            always shown as text (never colour alone). */}
                        {q.parts && q.parts.length > 0 && (
                          <SubPartBreakdown parts={q.parts} reasoning={q.grading_reason} block />
                        )}

                        {/* Legacy fallback — flattened prose for questions without
                            structured sub-parts. */}
                        {(!q.parts || q.parts.length === 0) && (
                        <>
                        {/* Answer Key Evidence */}
                        {q.answer_key_evidence && !(q.question || q.question_text) && (
                          <div style={{ background: 'var(--color-paper-soft, #FAF8F2)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
                            <p style={labelStyle}>Answer key</p>
                            <div className="markdown-content" style={{ fontSize: 13, color: INK, margin: 0 }}>
                              <MathText text={q.answer_key_evidence} stripJargon={false} block />
                            </div>
                          </div>
                        )}

                        {/* Student answer - always show, even if not attempted */}
                        <div style={{ background: q.student_answer && ok ? 'var(--success-soft)' : '#fff', border: `1px solid ${q.student_answer && ok ? 'transparent' : HAIRLINE}`, borderRadius: 8, padding: '8px 10px', marginBottom: 4 }}>
                          <p style={labelStyle}>Your answer</p>
                          {q.student_answer ? (
                            <div className="markdown-content" style={{ fontSize: 13, color: INK, margin: 0 }}>
                              <MathText text={q.student_answer} stripJargon={false} block />
                            </div>
                          ) : (
                            <p style={{ fontSize: 13, color: TEXT_2, margin: 0, fontStyle: 'italic' }}>Not attempted</p>
                          )}
                        </div>

                        {/* Correct answer (if wrong) */}
                        {!ok && q.correct_answer && q.correct_answer !== '-' && (
                          <div style={{ background: 'var(--success-soft)', borderRadius: 8, padding: '8px 10px', marginBottom: 4 }}>
                            <p style={{ ...labelStyle, color: 'var(--success-soft-foreground)' }}>Correct answer</p>
                            <div className="markdown-content" style={{ fontSize: 13, color: INK, margin: 0 }}>
                              <MathText text={q.correct_answer} stripJargon={false} block />
                            </div>
                          </div>
                        )}

                        {/* Grading reason - why these marks were awarded */}
                        {q.grading_reason && (
                          <div style={{ background: 'var(--color-paper-soft, #FAF8F2)', borderRadius: 8, padding: '8px 10px', marginBottom: 4 }}>
                            <p style={labelStyle}>Grading reason</p>
                            <div className="markdown-content" style={{ fontSize: 13, color: TEXT_2, margin: 0, lineHeight: 1.55 }}>
                              <MathText text={cleanReportText(q.grading_reason)} stripJargon={false} block />
                            </div>
                          </div>
                        )}
                        </>
                        )}

                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        </div>

        <div id="answer-sheets" className="report-answer-sheets" style={{ padding: '0 48px' }}>
        {['student', 'teacher', 'admin', 'skyll_admin'].includes(localStorage.getItem('userRole')) && <AnswerSheetGallery subjects={subjects} studentUsername={reportStudentUsername} testId={workflow.test_id || examInfo?.id} className="no-print mt-10 border-t-2 border-ink pt-5" />}
        </div>

        {/* ── FOOTER ── */}
        <div className="report-footer" style={{ margin: '40px 48px 0', borderTop: `2px solid ${INK}`, paddingTop: 16, paddingBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: CAPTION }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <SkyllMark size={16} />
            <span className="report-display" style={{ fontWeight: 700, color: INK }}>Skyll</span>
            <span>· Building future-ready learners</span>
          </div>
          <span>{name} · {examInfo?.name} · {today}</span>
        </div>

        <div className="report-disclaimer" style={{ textAlign: 'center', padding: '0 48px 40px', fontSize: 12, color: CAPTION }}>
          <p style={{ margin: '0 0 4px' }}>This report was generated to support learning and reflection.</p>
          <p style={{ margin: '0 0 8px' }}>Not a substitute for professional educational assessment.</p>
          <p style={{ margin: 0, color: INK, fontWeight: 600 }}>office@skyllai.com</p>
        </div>

      </div>
    </>
  );
}
