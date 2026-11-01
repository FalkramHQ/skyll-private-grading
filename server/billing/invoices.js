import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { internalError } from '../../api/_lib/httpError.js';
import {
  InvoiceError,
  generateInvoice,
  getInvoice,
  listInvoices,
  markInvoicePaid,
  previewInvoice,
  unmarkInvoicePaid,
  voidInvoice,
} from '../../api/_lib/invoices.js';

/**
 * Monthly school invoices (FLKRM-486), folded into the auth catch-all
 * (12-function cap). skyll_admin only; schools don't see invoices yet.
 *
 *   GET  /api/auth/invoices[?schoolId=]   newest-first list + unpaid totals per school
 *   GET  /api/auth/invoices?id=           one invoice with its lines and billed papers
 *   GET  /api/auth/invoices?id=&format=pdf  the invoice PDF (FLKRM-487), drawn on each
 *                                         download; VOID watermark when voided
 *   POST /api/auth/invoices { action, … }
 *     preview      { schoolId, period }   what would be billed, and whether it can be
 *     generate     { schoolId, period }   issue SKY/<FY>/<seq> (completed months only)
 *     void         { invoiceId, reason }  refused while marked paid; frees the papers
 *     mark-paid    { invoiceId, paidOn, reference? }
 *     unmark-paid  { invoiceId }
 */
const first = (value) => String((Array.isArray(value) ? value[0] : value) ?? '').trim();

export default async function invoices(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['skyll_admin']);
    if (!user) return;
    const db = database();
    const actor = user.username || user.user_id || 'skyll_admin';
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method === 'GET') {
      const id = first(req.query?.id);
      if (id && first(req.query?.format) === 'pdf') {
        const invoice = await getInvoice(db, id);
        // Lazy: pdfkit and the fonts load only for downloads, not every auth request.
        const pdf = await import('../../api/_lib/invoicePdf.js');
        const body = await pdf.renderInvoicePdf(invoice, { signature: await pdf.loadSignature() });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${pdf.pdfFilename(invoice)}"`);
        res.setHeader('Content-Length', String(body.length));
        return res.status(200).send(body);
      }
      if (id) return res.status(200).json({ invoice: await getInvoice(db, id) });
      return res.status(200).json(await listInvoices(db, { schoolId: first(req.query?.schoolId) || null }));
    }

    const body = req.body || {};
    const schoolId = first(body.schoolId);
    const invoiceId = first(body.invoiceId);
    switch (body.action) {
      case 'preview':
        return res.status(200).json({ preview: await previewInvoice(db, { schoolId, period: first(body.period) }) });
      case 'generate':
        return res.status(201).json({ invoice: await generateInvoice(db, { schoolId, period: first(body.period), issuedBy: actor }) });
      case 'void':
        return res.status(200).json({ invoice: await voidInvoice(db, { invoiceId, reason: body.reason, voidedBy: actor }) });
      case 'mark-paid':
        return res.status(200).json({ invoice: await markInvoicePaid(db, { invoiceId, paidOn: body.paidOn, reference: body.reference, markedBy: actor }) });
      case 'unmark-paid':
        return res.status(200).json({ invoice: await unmarkInvoicePaid(db, { invoiceId }) });
      default:
        return res.status(400).json({ error: 'Unknown action.' });
    }
  } catch (error) {
    if (error instanceof InvoiceError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    if (error?.name === 'InvoicePdfError') return res.status(error.statusCode).json({ error: error.message, code: 'pdf_not_configured' });
    return internalError(res, error, 'invoices');
  }
}
