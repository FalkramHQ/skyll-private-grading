// @vitest-environment node
// FLKRM-487: invoice PDFs drawn with pdfkit on download — content, VOID,
// pagination, required configuration, and the download route.
import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ signature: null, invoice: null, storage: 'ok' }));
// A 1×1 transparent PNG stands in for the real signature.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

vi.mock('../../api/_lib/storage.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getObject: async ({ key }) => {
    if (state.storage === 'throw') throw new Error('Missing S3_ENDPOINT');
    if (state.storage === 'forbidden') return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) };
    return state.signature && key === 'billing/invoice-signature.png'
      ? { ok: true, status: 200, arrayBuffer: async () => state.signature }
      : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  },
}));
vi.mock('../../api/_lib/auth.js', () => ({
  database: () => ({}),
  ensureAuthTables: async () => {},
  requireUser: async (_req, res, roles) => {
    if (!roles.includes(state.role)) { res.status(403).json({ error: 'forbidden' }); return null; }
    return { username: 'sky_admin', role: state.role };
  },
}));
vi.mock('../../api/_lib/invoices.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getInvoice: async () => state.invoice,
}));

const { FALKRAM_BANK, formatINR, loadSignature, pdfFilename, renderInvoicePdf } = await import('../../api/_lib/invoicePdf.js');
const { default: handler } = await import('../../server/billing/invoices.js');

const BANK = { accountName: 'FALKRAM PRIVATE LIMITED', accountNo: '000111222333', ifsc: 'TEST0000001', bank: 'Test Bank' };
const line = (examName, examDate, maxMarks, papers) => ({ examId: examName, examName, examDate, maxMarks, papers, ratePaisePerMark: 25, amountPaise: maxMarks * papers * 25 });
const INVOICE = {
  id: 'inv_1', number: 'SKY/2026-27/0001', status: 'issued', invoiceDate: '2026-10-02', period: '2026-09', school: 'Alpha Classes',
  billTo: { legalName: 'Alpha Classes Pvt Ltd', address: 'Office 4, FC Road\nPune 411004', gstin: '27ABCDE1234F1Z5', pan: null, placeOfSupply: 'Maharashtra' },
  lines: [line('Physics Unit 1', '2026-09-05', 25, 1), line('Chemistry Unit 1', '2026-09-08', 35, 2), line('Maths Half Yearly', '2026-09-12', 80, 1), line('Biology Prelim', '2026-08-01', 100, 1)],
  subtotalPaise: 6875, roundOffPaise: 25, totalPaise: 6900,
};

const pageCount = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;
async function render(invoice = INVOICE) {
  const trace = [];
  const pdf = await renderInvoicePdf(invoice, { signature: PNG, bank: BANK, trace });
  return { pdf, trace, strings: trace.map((t) => t.value) };
}

describe('renderInvoicePdf', () => {
  it('draws the kit invoice from the stored invoice only', async () => {
    const { pdf, strings } = await render();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(1);
    expect(strings).toEqual(expect.arrayContaining([
      'FALKRAM PVT LTD', 'CIN U32409PN2026PTC258972 · Pune, Maharashtra, India', 'INVOICE',
      'Invoice No: SKY/2026-27/0001', 'Date: 2 October 2026', 'Period: September 2026',
      'BILL TO', 'Alpha Classes Pvt Ltd\nOffice 4, FC Road\nPune 411004', 'GSTN', '27ABCDE1234F1Z5', 'PAN', '—', 'PLACE OF SUPPLY', 'Maharashtra',
      'Particulars', 'EXAM', 'DATE', 'MARKS', 'PAPERS', 'RATE', 'AMOUNT (INR)',
      'Chemistry Unit 1', '8 Sept 2026', '35', '2', '₹0.25 / mark', '17.50',
      'Subtotal', '68.75', 'Round-off', '0.25', 'Total', '69.00',
      'Total Amount Chargeable', 'INR 69.00',
      'BANK DETAILS', 'Account Name: FALKRAM PRIVATE LIMITED', 'Account No: 000111222333', 'IFSC: TEST0000001', 'Bank: Test Bank', 'AUTHORISED SIGNATORY',
      'This is a Computer Generated Invoice', 'Falkram PVT LTD · Invoice SKY/2026-27/0001 · 2 October 2026',
      'Falkram PVT LTD · Confidential', '1 / 1',
    ]));
    expect(strings.some((s) => /due/i.test(s))).toBe(false);
    expect(strings).not.toContain('VOID');
    // Only the bundled fonts: pdfkit's built-in Helvetica is never loaded.
    expect(pdf.toString('latin1')).not.toMatch(/\/BaseFont \/Helvetica/);
  });

  it('keeps over-long text on the page: address capped at 6 lines, long exam names clipped', async () => {
    const address = Array.from({ length: 250 }, () => 'x').join('\n');
    const longName = `Combined revision ${'paper '.repeat(60)}`;
    const { pdf, trace } = await render({ ...INVOICE, billTo: { ...INVOICE.billTo, address }, lines: [line(longName, '2026-09-05', 25, 1)], subtotalPaise: 625, roundOffPaise: -25, totalPaise: 600 });
    // No runaway pages: pdfkit adds a page by itself when text overflows, and such
    // a page would carry only the footer. Every page must hold drawn content.
    const pages = pageCount(pdf);
    expect(pages).toBeLessThanOrEqual(2);
    const footer = new Set(['Falkram PVT LTD · Confidential', `${pages} / ${pages}`, ...Array.from({ length: pages }, (_, i) => `${i + 1} / ${pages}`)]);
    for (let page = 0; page < pages; page += 1) expect(trace.some((t) => t.page === page && !footer.has(t.value)), `page ${page + 1} has content`).toBe(true);
    const billTo = trace.find((t) => t.value.startsWith('Alpha Classes Pvt Ltd\n')).value;
    expect(billTo.split('\n')).toHaveLength(1 + 6);
    const drawnName = trace.find((t) => t.value.startsWith('Combined revision')).value;
    expect(drawnName.length).toBeLessThanOrEqual(140);
    expect(drawnName.endsWith('…')).toBe(true);
  });

  it('shows a banded line as a price per paper (#311)', async () => {
    const banded = { ...INVOICE, lines: [{ examId: 'e', examName: 'Mid term', examDate: '2026-09-05', maxMarks: 80, papers: 3, ratePaisePerMark: null, pricePaisePerPaper: 2000, amountPaise: 6000 }], subtotalPaise: 6000, roundOffPaise: 0, totalPaise: 6000 };
    const { strings } = await render(banded);
    expect(strings).toContain('₹20.00 / paper');
    expect(strings).not.toContain('₹0.25 / mark');
  });

  it('formats amounts with Indian digit grouping', () => {
    expect(formatINR(12337500)).toBe('1,23,375.00');
    expect(formatINR(-25)).toBe('-0.25');
    expect(formatINR(625)).toBe('6.25');
  });

  it('watermarks every page of a voided invoice and says why', async () => {
    const { trace } = await render({ ...INVOICE, status: 'void', voidedAt: '2026-10-03T05:00:00.000Z', voidReason: 'Wrong legal name' });
    expect(trace.filter((t) => t.value === 'VOID').map((t) => t.page)).toEqual([0]);
    expect(trace.map((t) => t.value)).toContain('VOID · 3 Oct 2026 · Wrong legal name');
  });

  it('paginates a long invoice: header repeated, rows whole, totals once, footer on every page', async () => {
    const lines = Array.from({ length: 70 }, (_, i) => line(`Weekly Test ${i + 1}${i % 9 === 0 ? ' — Physics, Chemistry and Mathematics combined revision paper' : ''}`, `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, 100, 40 + i));
    const subtotal = lines.reduce((sum, l) => sum + l.amountPaise, 0);
    const { pdf, trace } = await render({ ...INVOICE, status: 'void', lines, subtotalPaise: subtotal, roundOffPaise: 0, totalPaise: subtotal });
    const pages = pageCount(pdf);
    expect(pages).toBeGreaterThanOrEqual(3);
    // The table header appears on every page that has rows.
    const rowPages = new Set(trace.filter((t) => t.value.startsWith('Weekly Test')).map((t) => t.page));
    const headerPages = new Set(trace.filter((t) => t.value === 'AMOUNT (INR)').map((t) => t.page));
    expect([...rowPages].every((p) => headerPages.has(p))).toBe(true);
    // Every exam row is drawn exactly once (never split across pages).
    expect(trace.filter((t) => t.value.startsWith('Weekly Test')).length).toBe(70);
    expect(trace.filter((t) => t.value === `INR ${formatINR(subtotal)}`)).toHaveLength(1);
    expect(trace.filter((t) => t.value === 'Falkram PVT LTD · Confidential').map((t) => t.page)).toEqual([...Array(pages).keys()]);
    expect(trace.filter((t) => t.value === 'VOID').map((t) => t.page)).toEqual([...Array(pages).keys()]);
    expect(trace.map((t) => t.value)).toContain(`${pages} / ${pages}`);
  }, 20_000); // draws a 70-line, 4-page PDF: slow under the full parallel suite

  it('names the file after the SKY number', () => {
    expect(pdfFilename(INVOICE)).toBe('SKY-2026-27-0001.pdf');
  });
});

describe('required configuration', () => {
  it("prints Falkram's bank details by default", async () => {
    expect(FALKRAM_BANK).toEqual({ accountName: 'FALKRAM PRIVATE LIMITED', accountNo: '00000000000000', ifsc: 'HDFC0000000', bank: 'HDFC Bank' });
    const trace = [];
    await renderInvoicePdf(INVOICE, { signature: PNG, trace });
    expect(trace.map((t) => t.value)).toEqual(expect.arrayContaining(['Account Name: FALKRAM PRIVATE LIMITED', 'Account No: 00000000000000', 'IFSC: HDFC0000000', 'Bank: HDFC Bank']));
  });

  it('needs the signature PNG in private storage', async () => {
    state.signature = null;
    await expect(loadSignature()).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('uploadInvoiceSignature') });
    state.signature = Buffer.from('not a png');
    await expect(loadSignature()).rejects.toMatchObject({ statusCode: 503 });
    state.signature = PNG;
    await expect(loadSignature()).resolves.toEqual(PNG);
  });

  it('does not blame a missing signature for storage failures', async () => {
    state.signature = PNG;
    state.storage = 'forbidden';
    await expect(loadSignature()).rejects.toThrow('HTTP 403');
    await expect(loadSignature()).rejects.not.toHaveProperty('statusCode');
    state.storage = 'throw';
    await expect(loadSignature()).rejects.toThrow('Missing S3_ENDPOINT');
    state.storage = 'ok';
  });
});

describe('GET /api/auth/invoices?id=&format=pdf', () => {
  beforeEach(() => {
    state.role = 'skyll_admin';
    state.invoice = INVOICE;
    state.signature = PNG;
    state.storage = 'ok';
  });
  function response() {
    return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } };
  }
  const call = async (query) => { const res = response(); await handler({ method: 'GET', query, headers: {} }, res); return res; };

  it('returns the PDF as an attachment', async () => {
    const res = await call({ id: 'inv_1', format: 'pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="SKY-2026-27-0001.pdf"');
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(Buffer.isBuffer(res.body) && res.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.headers['Content-Length']).toBe(String(res.body.length));
  });

  it('explains a missing signature instead of sending a partial invoice', async () => {
    state.signature = null;
    const res = await call({ id: 'inv_1', format: 'pdf' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'pdf_not_configured', error: expect.stringContaining('uploadInvoiceSignature') });
  });

  it('logs storage failures as internal errors, not "not configured"', async () => {
    state.storage = 'forbidden';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call({ id: 'inv_1', format: 'pdf' });
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('invoices'), expect.objectContaining({ message: expect.stringContaining('HTTP 403') }));
    errors.mockRestore();
    state.storage = 'ok';
  });

  it('refuses everyone but platform admins', async () => {
    state.role = 'admin';
    expect((await call({ id: 'inv_1', format: 'pdf' })).statusCode).toBe(403);
  });
});
