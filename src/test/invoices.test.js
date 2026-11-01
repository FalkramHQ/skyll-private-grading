// FLKRM-486: monthly per-school invoices — exact calculation, SKY numbering,
// one live invoice per month, billed-once papers, void, payment tracking.
// Real SQL on the production schema.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDatabase } from './helpers/schemaDatabase.js';

const state = vi.hoisted(() => ({ db: null, user: null }));
vi.mock('../../api/_lib/auth.js', () => ({
  database: () => state.db,
  ensureAuthTables: async () => {},
  requireUser: async (_req, res, roles) => {
    if (roles && !roles.includes(state.user.role)) { res.status(403).json({ error: 'forbidden' }); return null; }
    return state.user;
  },
}));

const lib = await import('../../api/_lib/invoices.js');
const { default: handler } = await import('../../server/billing/invoices.js');
const { financialYear, generateInvoice, invoiceNumber, listInvoices, markInvoicePaid, periodBounds, previewInvoice, priceInvoice, unmarkInvoicePaid, voidInvoice } = lib;

const T = '2026-08-01T00:00:00.000Z';
const OCT_2 = new Date('2026-10-02T05:00:00.000Z'); // 10:30 IST
const ADMIN = 'sky_admin';

function q(id, submissionId, attempted) {
  return ['INSERT INTO submission_questions_v2 (id, submission_id, exam_set_question_id, question_number, ai_marks, status, evidence_json, source_asset_ids_json, render_json, review_revision, regraded_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0, 0, ?, ?)',
    [id, submissionId, `esq_${id}`, id, 'graded', '{}', '[]', JSON.stringify({ studentAnswer: { attempted } }), T, T]];
}

function paper(id, examId, studentId, maxMarks, gradedAt, attempted = [true]) {
  return [
    ['INSERT INTO submissions (id, exam_id, student_id, status, score, max_marks, graded_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)', [id, examId, studentId, 'ready_for_review', maxMarks, gradedAt, T, T]],
    ...attempted.map((value, index) => q(`${id}_q${index + 1}`, id, value)),
  ];
}

const school = (id, name) => ['INSERT INTO schools (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, id, name, 'active', T, T]];
const exam = (id, schoolId, name, examDate, status = 'published', archivedAt = null) => ['INSERT INTO exams (id, school_id, subject_id, academic_year_id, name, exam_date, status, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, schoolId, 'subj', 'ay', name, examDate, status, archivedAt, T, T]];
const student = (id, schoolId, name) => ['INSERT INTO students (id, school, school_id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, schoolId, schoolId, name, 'active', T, T]];
const profile = (schoolId, legalName) => ['INSERT INTO school_billing_profiles (school_id, legal_name, address, gstin, pan, place_of_supply, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [schoolId, legalName, 'FC Road\nPune', null, 'ABCDE1234F', 'Maharashtra', 'seed', T, T]];

async function seed(db) {
  const rows = [
    school('sch_a', 'Alpha Classes'), school('sch_b', 'Beta Institute'), school('sch_demo', 'Skyll Demo School'),
    profile('sch_a', 'Alpha Classes Pvt Ltd'), profile('sch_b', 'Beta Institute LLP'),
    exam('ex_x', 'sch_a', 'Physics Unit 1', '2026-09-05'),
    exam('ex_y', 'sch_a', 'Chemistry Unit 1', '2026-09-08'),
    exam('ex_z', 'sch_a', 'Maths Half Yearly', '2026-09-12'),
    exam('ex_w', 'sch_a', 'Biology Prelim', null),
    exam('ex_arch', 'sch_a', 'Archived Test', '2026-09-02', 'archived', '2026-09-20T00:00:00.000Z'),
    exam('ex_b', 'sch_b', 'Beta Physics', '2026-09-03'),
    exam('ex_demo', 'sch_demo', 'Demo Exam', '2026-09-03'),
    ...['asha', 'ravi', 'meera', 'kabir', 'zoya', 'dev', 'ira', 'om', 'pia', 'raj'].map((name) => student(`st_${name}`, 'sch_a', name[0].toUpperCase() + name.slice(1))),
    student('st_beta', 'sch_b', 'Bela'),
    // Billed in September 2026 (IST): 625 + 875 + 875 + 2000 + 2500 = 6875 paise.
    ...paper('p_x25', 'ex_x', 'st_asha', 25, '2026-09-10T06:00:00.000Z'),
    ...paper('p_y35a', 'ex_y', 'st_ravi', 35, '2026-09-15T06:00:00.000Z'),
    ...paper('p_y35b', 'ex_y', 'st_meera', 35, '2026-08-31T19:00:00.000Z'), // 1 Sep 00:30 IST
    ...paper('p_z80', 'ex_z', 'st_kabir', 80, '2026-09-20T06:00:00.000Z', [false, true]), // partly answered: billed in full
    ...paper('p_w100', 'ex_w', 'st_zoya', 100, '2026-09-25T06:00:00.000Z'),
    // Not billed in September.
    ...paper('p_oct', 'ex_x', 'st_dev', 25, '2026-09-30T19:00:00.000Z'), // 1 Oct 00:30 IST → October
    ...paper('p_blank', 'ex_x', 'st_ira', 25, '2026-09-11T06:00:00.000Z', [false, false]),
    ...paper('p_arch', 'ex_arch', 'st_om', 40, '2026-09-11T06:00:00.000Z'),
    ...paper('p_deleted', 'ex_gone', 'st_pia', 50, '2026-09-11T06:00:00.000Z'), // its test (and exam) was deleted
    ...paper('p_noreport', 'ex_x', 'st_raj', 25, null),
    ...paper('p_beta', 'ex_b', 'st_beta', 20, '2026-09-12T06:00:00.000Z'),
    ...paper('p_demo', 'ex_demo', 'st_beta', 20, '2026-09-12T06:00:00.000Z'),
  ];
  await db.batch(rows.map(([sql, args]) => ({ sql, args })), 'write');
}

const counter = async (fy) => (await state.db.execute({ sql: 'SELECT last_seq FROM invoice_counters WHERE fy = ?', args: [fy] })).rows[0]?.last_seq ?? null;
const generate = (schoolId, period, now = OCT_2) => generateInvoice(state.db, { schoolId, period, issuedBy: ADMIN, now });

beforeEach(async () => {
  state.user = { user_id: 'u_sky', username: ADMIN, role: 'skyll_admin' };
  state.db = await createSchemaDatabase();
  await seed(state.db);
});

describe('invoice arithmetic', () => {
  it('uses the invoice date\'s financial year and 4-digit sequences', () => {
    expect(financialYear('2026-10-02')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2027-04-01')).toBe('2027-28');
    expect(invoiceNumber('2026-27', 7)).toBe('SKY/2026-27/0007');
  });

  it('bounds a month in Asia/Kolkata time', () => {
    expect(periodBounds('2026-09')).toEqual({ start: '2026-08-31T18:30:00.000Z', end: '2026-09-30T18:30:00.000Z' });
    expect(periodBounds('2026-12').end).toBe('2026-12-31T18:30:00.000Z');
  });

  it('keeps exact paise per line and rounds only the total, 50 paise up', () => {
    const at = (maxMarks) => ({ examId: 'e', examName: 'E', examDate: null, maxMarks });
    expect(priceInvoice([at(25), at(25)])).toMatchObject({ subtotalPaise: 1250, roundOffPaise: 50, totalPaise: 1300 });
    expect(priceInvoice([at(25)])).toMatchObject({ subtotalPaise: 625, roundOffPaise: -25, totalPaise: 600 });
    expect(priceInvoice([at(70)])).toMatchObject({ subtotalPaise: 1750, roundOffPaise: 50, totalPaise: 1800 });
    expect(priceInvoice([at(100), at(80), at(40), at(20)])).toMatchObject({ subtotalPaise: 6000, roundOffPaise: 0, totalPaise: 6000 });
  });
});

const lineView = (lines) => lines.map(({ examName, examDate, maxMarks, papers, ratePaisePerMark, amountPaise }) => ({ examName, examDate, maxMarks, papers, ratePaisePerMark, amountPaise }));
const SEPTEMBER_LINES = [
  // No exam_date: falls back to the exam's created date (2026-08-01).
  { examName: 'Biology Prelim', examDate: '2026-08-01', maxMarks: 100, papers: 1, ratePaisePerMark: 25, amountPaise: 2500 },
  { examName: 'Physics Unit 1', examDate: '2026-09-05', maxMarks: 25, papers: 1, ratePaisePerMark: 25, amountPaise: 625 },
  { examName: 'Chemistry Unit 1', examDate: '2026-09-08', maxMarks: 35, papers: 2, ratePaisePerMark: 25, amountPaise: 1750 },
  { examName: 'Maths Half Yearly', examDate: '2026-09-12', maxMarks: 80, papers: 1, ratePaisePerMark: 25, amountPaise: 2000 },
];

describe('preview', () => {
  it('bills exactly the September papers, one line per exam, ₹68.75 rounded to ₹69', async () => {
    const preview = await previewInvoice(state.db, { schoolId: 'sch_a', period: '2026-09', now: OCT_2 });
    // Excluded: October by IST (p_oct), blank (p_blank), archived exam (p_arch),
    // deleted test (p_deleted), no report (p_noreport), other schools.
    expect(preview.papers.map((p) => p.submissionId).sort()).toEqual(['p_w100', 'p_x25', 'p_y35a', 'p_y35b', 'p_z80']);
    expect(lineView(preview.lines)).toEqual(SEPTEMBER_LINES);
    expect(preview).toMatchObject({ paperCount: 5, subtotalPaise: 6875, roundOffPaise: 25, totalPaise: 6900, canGenerate: true, blocker: null });
  });

  it('puts the paper graded at 00:30 IST on 1 October into October', async () => {
    const preview = await previewInvoice(state.db, { schoolId: 'sch_a', period: '2026-10', now: OCT_2 });
    expect(preview.papers.map((p) => p.submissionId)).toEqual(['p_oct']);
    expect(preview.blocker.code).toBe('month_not_over');
  });
});

describe('generate', () => {
  it('issues SKY/2026-27/0001 with frozen lines, papers and bill-to snapshot', async () => {
    const invoice = await generate('sch_a', '2026-09');
    expect(invoice).toMatchObject({ number: 'SKY/2026-27/0001', status: 'issued', period: '2026-09', invoiceDate: '2026-10-02', paperCount: 5, subtotalPaise: 6875, roundOffPaise: 25, totalPaise: 6900, issuedBy: ADMIN, paidOn: null });
    expect(invoice.billTo).toEqual({ legalName: 'Alpha Classes Pvt Ltd', address: 'FC Road\nPune', gstin: null, pan: 'ABCDE1234F', placeOfSupply: 'Maharashtra' });
    expect(lineView(invoice.lines)).toEqual(SEPTEMBER_LINES);
    expect(invoice.papers.map((p) => [p.studentName, p.maxMarks, p.amountPaise])).toEqual([['Kabir', 80, 2000], ['Meera', 35, 875], ['Ravi', 35, 875], ['Zoya', 100, 2500], ['Asha', 25, 625]].sort((a, b) => a[0].localeCompare(b[0])));

    // Later edits to the profile or the papers never change an issued invoice.
    await state.db.execute("UPDATE school_billing_profiles SET legal_name = 'Renamed Ltd' WHERE school_id = 'sch_a'");
    await state.db.execute("UPDATE submissions SET max_marks = 90, score = 80 WHERE id = 'p_z80'");
    const again = await lib.getInvoice(state.db, invoice.id);
    expect(again.billTo.legalName).toBe('Alpha Classes Pvt Ltd');
    expect(again.totalPaise).toBe(6900);
  });

  it('bills a paper once: a regrade afterwards does not bring it back', async () => {
    await generate('sch_a', '2026-09');
    await state.db.execute("UPDATE submissions SET score = 2, status = 'graded', updated_at = '2026-10-05T00:00:00.000Z' WHERE id = 'p_x25'");
    const preview = await previewInvoice(state.db, { schoolId: 'sch_a', period: '2026-09', now: OCT_2 });
    expect(preview.papers).toEqual([]);
    expect(preview.blocker.code).toBe('already_invoiced');
    await expect(generate('sch_a', '2026-09')).rejects.toMatchObject({ statusCode: 409, code: 'already_invoiced' });
    expect(await counter('2026-27')).toBe(1);
  });

  it('numbers across schools in order and restarts each financial year', async () => {
    expect((await generate('sch_a', '2026-09')).number).toBe('SKY/2026-27/0001');
    expect((await generate('sch_b', '2026-09')).number).toBe('SKY/2026-27/0002');
    await state.db.batch([student('st_bina', 'sch_b', 'Bina'), ...paper('p_mar', 'ex_b', 'st_bina', 40, '2027-03-15T06:00:00.000Z')].map(([sql, args]) => ({ sql, args })), 'write');
    const april = await generate('sch_b', '2027-03', new Date('2027-04-02T05:00:00.000Z'));
    expect(april).toMatchObject({ number: 'SKY/2027-28/0001', invoiceDate: '2027-04-02', totalPaise: 1000 });
  });

  it.each([
    ['the current month', 'sch_a', '2026-10', 'month_not_over'],
    ['a month before invoicing started', 'sch_a', '2026-08', 'before_start'],
    ['a school without a billing profile', 'sch_demo', '2026-09', 'profile_incomplete'],
    ['a month with no billable papers', 'sch_b', '2026-11', 'nothing_to_invoice'],
  ])('refuses %s without using a number', async (_label, schoolId, period, code) => {
    const now = period === '2026-11' ? new Date('2026-12-03T05:00:00.000Z') : OCT_2;
    await expect(generate(schoolId, period, now)).rejects.toMatchObject({ statusCode: 422, code });
    expect(await counter('2026-27')).toBeNull();
  });

  it('stays gap-free when two requests race for the same month', async () => {
    const results = await Promise.allSettled([generate('sch_a', '2026-09'), generate('sch_a', '2026-09')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ statusCode: 409 });
    expect(await counter('2026-27')).toBe(1);
    expect((await generate('sch_b', '2026-09')).number).toBe('SKY/2026-27/0002');
  });

  it('gives racing requests for different schools distinct numbers', async () => {
    const [a, b] = await Promise.all([generate('sch_a', '2026-09'), generate('sch_b', '2026-09')]);
    expect([a.number, b.number].sort()).toEqual(['SKY/2026-27/0001', 'SKY/2026-27/0002']);
  });
});

describe('per-school pricing bands (#311)', () => {
  const setBands = (schoolId, bands) => state.db.batch([
    { sql: 'DELETE FROM school_pricing_bands WHERE school_id = ?', args: [schoolId] },
    ...bands.map(([maxMarks, pricePaise]) => ({ sql: 'INSERT INTO school_pricing_bands (school_id, max_marks, price_paise, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)', args: [schoolId, maxMarks, pricePaise, 'test', T] })),
  ], 'write');
  const priceView = (lines) => lines.map(({ examName, maxMarks, papers, ratePaisePerMark, pricePaisePerPaper, amountPaise }) => ({ examName, maxMarks, papers, ratePaisePerMark, pricePaisePerPaper, amountPaise }));

  it('bills a banded school per paper from the covering band, and freezes each line\'s price', async () => {
    await setBands('sch_a', [[25, 700], [40, 900], [100, 2000]]);
    const preview = await previewInvoice(state.db, { schoolId: 'sch_a', period: '2026-09', now: OCT_2 });
    expect(preview.pricing).toEqual({ isDefault: false, bands: [{ maxMarks: 25, pricePaise: 700 }, { maxMarks: 40, pricePaise: 900 }, { maxMarks: 100, pricePaise: 2000 }] });
    expect(priceView(preview.lines)).toEqual([
      { examName: 'Biology Prelim', maxMarks: 100, papers: 1, ratePaisePerMark: null, pricePaisePerPaper: 2000, amountPaise: 2000 },
      { examName: 'Physics Unit 1', maxMarks: 25, papers: 1, ratePaisePerMark: null, pricePaisePerPaper: 700, amountPaise: 700 },
      { examName: 'Chemistry Unit 1', maxMarks: 35, papers: 2, ratePaisePerMark: null, pricePaisePerPaper: 900, amountPaise: 1800 },
      { examName: 'Maths Half Yearly', maxMarks: 80, papers: 1, ratePaisePerMark: null, pricePaisePerPaper: 2000, amountPaise: 2000 },
    ]);
    expect(preview).toMatchObject({ paperCount: 5, subtotalPaise: 6500, roundOffPaise: 0, totalPaise: 6500, canGenerate: true });

    const invoice = await generate('sch_a', '2026-09');
    expect(priceView(invoice.lines)).toEqual(priceView(preview.lines));
    expect(invoice.papers.find((p) => p.submissionId === 'p_y35a').amountPaise).toBe(900);
    const stored = (await state.db.execute({ sql: 'SELECT rate_paise_per_mark, price_paise_per_paper FROM invoice_lines WHERE invoice_id = ? AND max_marks = 35', args: [invoice.id] })).rows[0];
    expect(stored).toMatchObject({ rate_paise_per_mark: 0, price_paise_per_paper: 900 });

    // Changing the price afterwards never touches the issued invoice.
    await setBands('sch_a', [[100, 9900]]);
    expect((await lib.getInvoice(state.db, invoice.id)).totalPaise).toBe(6500);
  });

  it('puts a 52-mark paper in the next band up', async () => {
    await state.db.batch([student('st_ana', 'sch_a', 'Ana'), ...paper('p_52', 'ex_x', 'st_ana', 52, '2026-09-12T06:00:00.000Z')].map(([sql, args]) => ({ sql, args })), 'write');
    await setBands('sch_a', [[50, 1000], [70, 1500], [100, 2000]]);
    const preview = await previewInvoice(state.db, { schoolId: 'sch_a', period: '2026-09', now: OCT_2 });
    expect(preview.papers.find((p) => p.submissionId === 'p_52').amountPaise).toBe(1500);
  });

  it('blocks generation when a total is above the top band, but still previews', async () => {
    await setBands('sch_a', [[40, 1000], [80, 2000]]);
    const preview = await previewInvoice(state.db, { schoolId: 'sch_a', period: '2026-09', now: OCT_2 });
    expect(preview.blocker).toMatchObject({ code: 'price_band_missing', message: expect.stringContaining('100-mark papers (1 paper)') });
    expect(preview.uncoveredTotals).toEqual([100]);
    expect(preview.unpricedPapers.map((p) => p.submissionId)).toEqual(['p_w100']);
    expect(preview).toMatchObject({ paperCount: 4, subtotalPaise: 1000 + 2000 + 2000, canGenerate: false });
    await expect(generate('sch_a', '2026-09')).rejects.toMatchObject({ statusCode: 422, code: 'price_band_missing' });
    expect(await counter('2026-27')).toBeNull();
  });

  it('keeps ₹0.25/mark for a school without bands in the same month', async () => {
    await setBands('sch_a', [[100, 2000]]);
    const [alpha, beta] = await Promise.all([generate('sch_a', '2026-09'), generate('sch_b', '2026-09')]);
    expect(alpha.lines.every((line) => line.pricePaisePerPaper === 2000 && line.ratePaisePerMark === null)).toBe(true);
    expect(priceView(beta.lines)).toEqual([{ examName: 'Beta Physics', maxMarks: 20, papers: 1, ratePaisePerMark: 25, pricePaisePerPaper: null, amountPaise: 500 }]);
  });
});

describe('void and reissue', () => {
  it('voids with a reason, keeps the number, frees the papers, and reissues with a new number', async () => {
    const first = await generate('sch_a', '2026-09');
    await expect(voidInvoice(state.db, { invoiceId: first.id, reason: ' ', voidedBy: ADMIN })).rejects.toMatchObject({ statusCode: 400 });
    const voided = await voidInvoice(state.db, { invoiceId: first.id, reason: 'Wrong legal name', voidedBy: ADMIN, now: OCT_2 });
    expect(voided).toMatchObject({ number: 'SKY/2026-27/0001', status: 'void', voidReason: 'Wrong legal name', voidedBy: ADMIN, voidedAt: OCT_2.toISOString() });
    expect(voided.papers.every((p) => p.releasedAt)).toBe(true);
    await expect(voidInvoice(state.db, { invoiceId: first.id, reason: 'again', voidedBy: ADMIN })).rejects.toMatchObject({ statusCode: 409 });

    const second = await generate('sch_a', '2026-09');
    expect(second).toMatchObject({ number: 'SKY/2026-27/0002', paperCount: 5, totalPaise: 6900 });
  });
});

describe('payment tracking', () => {
  it('marks paid with date and reference, blocks void while paid, and can be undone', async () => {
    const invoice = await generate('sch_a', '2026-09');
    const paid = await markInvoicePaid(state.db, { invoiceId: invoice.id, paidOn: '2026-10-05', reference: 'UTR123', markedBy: ADMIN, now: new Date('2026-10-06T00:00:00.000Z') });
    expect(paid).toMatchObject({ paidOn: '2026-10-05', paidReference: 'UTR123', paidMarkedBy: ADMIN });
    await expect(markInvoicePaid(state.db, { invoiceId: invoice.id, paidOn: '2026-10-05', markedBy: ADMIN, now: new Date('2026-10-06T00:00:00.000Z') })).rejects.toMatchObject({ statusCode: 409 });
    await expect(voidInvoice(state.db, { invoiceId: invoice.id, reason: 'x', voidedBy: ADMIN })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('paid') });
    expect((await listInvoices(state.db)).unpaid).toEqual([]);

    const unpaid = await unmarkInvoicePaid(state.db, { invoiceId: invoice.id });
    expect(unpaid).toMatchObject({ paidOn: null, paidReference: null });
    expect((await listInvoices(state.db)).unpaid).toEqual([{ schoolId: 'sch_a', school: 'Alpha Classes', invoices: 1, totalPaise: 6900 }]);
    expect((await voidInvoice(state.db, { invoiceId: invoice.id, reason: 'x', voidedBy: ADMIN })).status).toBe('void');
    await expect(markInvoicePaid(state.db, { invoiceId: invoice.id, paidOn: '2026-10-05', markedBy: ADMIN })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects a bad or future paid date and allows no reference (cash)', async () => {
    const invoice = await generate('sch_a', '2026-09');
    const now = new Date('2026-10-06T00:00:00.000Z');
    await expect(markInvoicePaid(state.db, { invoiceId: invoice.id, paidOn: '5/10/2026', markedBy: ADMIN, now })).rejects.toMatchObject({ statusCode: 400 });
    await expect(markInvoicePaid(state.db, { invoiceId: invoice.id, paidOn: '2026-10-09', markedBy: ADMIN, now })).rejects.toMatchObject({ statusCode: 400 });
    expect((await markInvoicePaid(state.db, { invoiceId: invoice.id, paidOn: '2026-10-06', markedBy: ADMIN, now })).paidReference).toBeNull();
  });
});

describe('/api/auth/invoices', () => {
  function response() {
    return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  }
  const call = async (method, { query = {}, body } = {}) => { const res = response(); await handler({ method, query, body, headers: {} }, res); return res; };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(OCT_2); });
  afterEach(() => { vi.useRealTimers(); });

  it('previews, generates, lists and shows an invoice', async () => {
    const preview = await call('POST', { body: { action: 'preview', schoolId: 'sch_a', period: '2026-09' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.body.preview).toMatchObject({ totalPaise: 6900, canGenerate: true });

    const created = await call('POST', { body: { action: 'generate', schoolId: 'sch_a', period: '2026-09' } });
    expect(created.statusCode).toBe(201);
    expect(created.body.invoice.number).toBe('SKY/2026-27/0001');

    const list = await call('GET');
    expect(list.headers['Cache-Control']).toBe('private, no-store');
    expect(list.body.invoices.map((i) => [i.number, i.school])).toEqual([['SKY/2026-27/0001', 'Alpha Classes']]);
    expect(list.body.unpaid).toEqual([{ schoolId: 'sch_a', school: 'Alpha Classes', invoices: 1, totalPaise: 6900 }]);
    expect((await call('GET', { query: { schoolId: 'sch_b' } })).body.invoices).toEqual([]);

    const detail = await call('GET', { query: { id: created.body.invoice.id } });
    expect(detail.body.invoice.papers).toHaveLength(5);
  });

  it('answers refusals with their status and code', async () => {
    expect((await call('POST', { body: { action: 'generate', schoolId: 'sch_demo', period: '2026-09' } })).body).toMatchObject({ code: 'profile_incomplete' });
    expect((await call('POST', { body: { action: 'preview', schoolId: 'sch_a', period: 'Sept' } })).statusCode).toBe(400);
    expect((await call('POST', { body: { action: 'preview', schoolId: 'sch_missing', period: '2026-09' } })).statusCode).toBe(404);
    expect((await call('GET', { query: { id: 'inv_missing' } })).statusCode).toBe(404);
    expect((await call('POST', { body: { action: 'refund' } })).statusCode).toBe(400);
    expect((await call('DELETE')).statusCode).toBe(405);
    state.user = { username: 'admin_a', role: 'admin', school_id: 'sch_a' };
    expect((await call('GET')).statusCode).toBe(403);
  });
});
