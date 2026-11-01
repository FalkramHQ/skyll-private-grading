import { Share } from 'react-native';
import { safeFilename, reportToHtml, shareReportPdf } from '../src/reportPdf';

jest.mock('expo-print', () => ({
  printToFileAsync: jest.fn(async () => ({ uri: 'file:///cache/Skyll_Report.pdf' })),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => {}),
}));

const Print = require('expo-print');
const Sharing = require('expo-sharing');

const report = {
  student: { name: 'Ada Lovelace', school: "Partner Academy A" },
  exams: [{ id: 'exam-a', name: 'Chemistry Unit Test' }],
  term1: {
    subjects: [
      {
        name: 'Chemistry',
        score: 7,
        total: 16,
        questions: [
          { id: 'q1', number: '1', marks_obtained: 2, marks_total: 4, question: 'Balance.', correct_answer: 'C + O2→CO2', student_answer: 'wrong.', grading_reason: 'Missed step.' },
        ],
      },
    ],
  },
};

describe('reportPdf', () => {
  let shareSpy;
  beforeEach(() => {
    shareSpy = jest.spyOn(Share, 'share').mockResolvedValueOnce();
  });
  afterEach(() => { jest.clearAllMocks(); shareSpy.mockRestore(); });

  it('sanitizes student/exam names into a safe filename', () => {
    expect(safeFilename("Ada Lovelace's Report!")).toBe('Ada_Lovelaces_Report');
    expect(safeFilename('../etc/passwd')).toBe('etcpasswd');
    expect(safeFilename('Chemistry — Unit Test 😀')).toBe('Chemistry_Unit_Test');
  });

  it('renders the published report payload into HTML with text labels', () => {
    const html = reportToHtml(report, { examId: 'exam-a' });
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Academy'); // school name present (HTML-escaped apostrophe)
    expect(html).toContain('Partial'); // concise correctness label, not colour alone
    expect(html).toContain('Correct answer');
    expect(html).toContain('Grading reasoning');
    expect(html).toContain('Chemistry');
  });

  it('escapes HTML-injection attempts in the report payload', () => {
    const hostile = {
      student: { name: '<script>alert(1)</script>' },
      exams: [],
      term1: { subjects: [{ name: '<img onerror=x>', score: 1, total: 2, questions: [{ question: '<b>&', correct_answer: '<i>' }] }] },
    };
    const html = reportToHtml(hostile);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shares a real PDF attachment via the Android share sheet', async () => {
    const result = await shareReportPdf(report, { examId: 'exam-a' });
    expect(result).toEqual({ ok: true, mode: 'pdf', filename: 'Ada_Lovelace_Chemistry_Unit_Test_Report.pdf' });
    expect(Print.printToFileAsync).toHaveBeenCalledTimes(1);
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/Skyll_Report.pdf', expect.objectContaining({ mimeType: 'application/pdf' }));
    expect(Share.share).not.toHaveBeenCalled();
  });

  it('falls back to plain-text sharing when PDF generation fails', async () => {
    Print.printToFileAsync.mockRejectedValueOnce(new Error('no engine'));
    const result = await shareReportPdf(report, { examId: 'exam-a' });
    expect(result).toEqual({ ok: true, mode: 'text', fallback: true });
    expect(Share.share).toHaveBeenCalledTimes(1);
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });
});
