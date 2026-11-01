// @vitest-environment node
// Fee PDFs (CRM M2 phase 1 S4): what invoices and receipts say (via the drawn
// text trace), that internal notes never appear, the VOID / PAID / REVERSED
// stamps, and the download routes' headers, permissions and school scoping.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, CRM_MIGRATIONS, FEES_MIGRATIONS, SEED, T, actors, grant, migrationStatements,
} from './classesHarness.js';

const state = vi.hoisted(() => ({ db: null }));
const auth = vi.hoisted(() => ({
  database: vi.fn(() => state.db),
  sessionForRequest: vi.fn(),
  ensureAuthTables: vi.fn(async () => undefined),
  requireUser: vi.fn(async () => null),
}));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));

const { handleCrmRequest } = await import('../../../server/crm/router.js');
const { renderFeeInvoicePdf, renderFeeReceiptPdf } = await import('../../../server/crm/feeDocuments.js');
const { admin, otherAdmin, teacher, staff } = actors;
let dir;

/** Like the harness caller, but the response also takes headers and a raw body. */
async function call(actor, method, route, { body, query = {} } = {}) {
  auth.sessionForRequest.mockResolvedValue(actor);
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
    send(payload) { this.raw = payload; this.headersSent = true; return this; },
  };
  await handleCrmRequest({ method, headers: {}, query, body }, res, route.split('/'));
  return res;
}

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-fee-docs-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T04:30:00.000Z'));
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Math.random()}.db`)}` });
  await state.db.batch([
    ...BASE_SCHEMA, ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS, ...FEES_MIGRATIONS]), ...SEED,
    `INSERT INTO crm_fee_settings (school_id, prefix, header_name, header_address, header_phone, footer_note, created_at, updated_at)
     VALUES ('sch_a', 'SA', 'School A Coaching', '12 MG Road
Pune 411001', '+91 98765 43210', 'Fees once paid are not refundable.', '${T}', '${T}')`,
  ], 'write');
});
afterEach(() => { vi.useRealTimers(); });

const SCHOOL = { name: 'School A Coaching', address: '12 MG Road\nPune 411001', phone: '+91 98765 43210', gstin: '27ABCDE1234F1Z5', footer: 'Fees once paid are not refundable.' };
const INVOICE = {
  number: 'SA/INV/2026-27/0007', status: 'issued', issueDate: '2026-10-14', dueDate: '2026-11-05', totalPaise: 1400000, paidPaise: 400000, voidReason: null,
  billTo: { student: { id: 'stu_1', name: 'Anaya Iyer' }, payer: { name: 'Ravi Iyer' }, school: SCHOOL },
  lines: [{ label: 'Admission fee', amountPaise: 200000 }, { label: 'Instalment 1', amountPaise: 1200000 }],
};
const PAYMENT = {
  id: 'pay_1', receiptNumber: 'SA/RCP/2026-27/0003', student: { id: 'stu_1', name: 'Anaya Iyer' }, amountPaise: 500000, receivedOn: '2026-10-14', method: 'upi',
  reference: 'UPI 6612 7781', payerName: 'Ravi Iyer', note: 'Uncle paid, call him about the rest', recordedAt: '2026-10-14T05:00:00.000Z',
  allocations: [{ invoiceId: 'inv_7', invoiceNumber: 'SA/INV/2026-27/0007', amountPaise: 400000 }], unallocatedPaise: 100000, reversal: null,
};

describe('Fee PDF content (S4)', () => {
  it('draws an invoice from its frozen bill-to, with paid to date and balance', async () => {
    const trace = [];
    const pdf = await renderFeeInvoicePdf(INVOICE, { today: '2026-10-14', trace });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(trace).toEqual(expect.arrayContaining([
      'School A Coaching', '12 MG Road', 'Pune 411001', 'Phone +91 98765 43210', 'GSTIN 27ABCDE1234F1Z5', 'INVOICE', 'Invoice no: SA/INV/2026-27/0007',
      'Due: 5 November 2026', 'Ravi Iyer', 'For Anaya Iyer', 'Admission fee', '₹2,000', '₹14,000', 'Paid to date', '₹4,000', 'Balance due', '₹10,000',
      'Fees once paid are not refundable.',
    ]));
    expect(trace).not.toContain('PAID');
  });

  it('stamps void invoices with the reason and paid invoices PAID', async () => {
    const voided = [];
    await renderFeeInvoicePdf({ ...INVOICE, status: 'void', paidPaise: 0, voidReason: 'Issued twice' }, { today: '2026-10-14', trace: voided });
    expect(voided).toEqual(expect.arrayContaining(['VOID', 'This invoice was cancelled: Issued twice']));
    expect(voided).not.toContain('Balance due');
    const paid = [];
    await renderFeeInvoicePdf({ ...INVOICE, paidPaise: 1400000 }, { today: '2026-10-14', trace: paid });
    expect(paid).toEqual(expect.arrayContaining(['PAID', '₹0']));
  });

  it('draws a receipt with method, reference, what it paid and credit, never the internal note', async () => {
    const trace = [];
    await renderFeeReceiptPdf(PAYMENT, { school: SCHOOL, studentName: 'Anaya Iyer', balancePaise: 1000000, trace });
    expect(trace).toEqual(expect.arrayContaining([
      'RECEIPT', 'Receipt no: SA/RCP/2026-27/0003', 'Received: 14 October 2026', 'Ravi Iyer', 'For Anaya Iyer', '₹5,000', 'UPI · Ref UPI 6612 7781',
      'Invoice SA/INV/2026-27/0007', '₹4,000', 'Kept as credit for future fees', '₹1,000', 'Balance still due', '₹10,000',
    ]));
    expect(trace.join('\n')).not.toMatch(/Uncle|call him/);
  });

  it('stamps a reversed receipt REVERSED with the reason and no allocations', async () => {
    const trace = [];
    await renderFeeReceiptPdf({ ...PAYMENT, allocations: [], unallocatedPaise: 0, reversal: { reason: 'Cheque bounced', at: '2026-10-15T06:00:00.000Z' } }, { school: SCHOOL, studentName: 'Anaya Iyer', balancePaise: 1400000, trace });
    expect(trace).toContain('REVERSED');
    expect(trace.join('\n')).toMatch(/reversed on 15 October 2026: Cheque bounced/);
    expect(trace).not.toContain('Applied to');
  });

  it('keeps very long names and many lines on the page', async () => {
    const trace = [];
    const lines = Array.from({ length: 40 }, (_, index) => ({ label: `Tuition: month ${index + 1} ${'x'.repeat(120)}`, amountPaise: 100000 }));
    const pdf = await renderFeeInvoicePdf({ ...INVOICE, lines, totalPaise: 4000000, billTo: { ...INVOICE.billTo, student: { name: 'N'.repeat(300) } } }, { today: '2026-10-14', trace });
    expect(pdf.length).toBeGreaterThan(1000);
    expect(trace.every((value) => value.length <= 400)).toBe(true);
  });
});

describe('Fee PDF downloads (S4)', () => {
  async function invoiceAndPayment() {
    const invoice = (await call(admin, 'POST', 'fees/invoices', { body: { studentId: 'stu_1', dueDate: '2026-11-05', lines: [{ label: 'Material kit', amountPaise: 150000 }] } })).body;
    const payment = (await call(admin, 'POST', 'fees/payments', { body: { studentId: 'stu_1', amountPaise: 150000, receivedOn: '2026-10-14', method: 'cash', note: 'Secret note' } })).body;
    return { invoice, payment };
  }

  it('returns invoice and receipt PDFs as attachments for finance readers in the school only', async () => {
    const { invoice, payment } = await invoiceAndPayment();
    const pdf = await call(admin, 'GET', 'fees/invoices/pdf', { query: { invoiceId: invoice.id } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers).toMatchObject({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="SA-INV-2026-27-0001.pdf"', 'cache-control': 'private, no-store' });
    expect(pdf.raw.subarray(0, 5).toString()).toBe('%PDF-');
    const receipt = await call(admin, 'GET', 'fees/payments/receipt', { query: { paymentId: payment.id } });
    expect(receipt.headers['content-disposition']).toBe('attachment; filename="SA-RCP-2026-27-0001.pdf"');

    expect((await call(otherAdmin, 'GET', 'fees/invoices/pdf', { query: { invoiceId: invoice.id } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'GET', 'fees/payments/receipt', { query: { paymentId: payment.id } })).statusCode).toBe(404);
    expect((await call(teacher, 'GET', 'fees/invoices/pdf', { query: { invoiceId: invoice.id } })).statusCode).toBe(403);
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.finance.read']);
    expect((await call(staff, 'GET', 'fees/payments/receipt', { query: { paymentId: payment.id } })).headers['content-type']).toBe('application/pdf');
    expect((await call(admin, 'GET', 'fees/invoices/pdf', { query: {} })).statusCode).toBe(422);
  });
});
