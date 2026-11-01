// Submitting Skyll's templates to a class's WhatsApp account and tracking
// Meta's approval (D6). Both languages are submitted on connect, so a class
// can switch language later without waiting. Meta then reports changes through
// the `message_template_status_update` webhook; Refresh re-reads them.
import { randomUUID } from 'node:crypto';
import { WA_LANGUAGES, WA_TEMPLATES, WA_TEMPLATE_KEYS, metaTemplateName, metaTemplatePayload } from '../../shared/crm/waTemplates.js';

const META_STATUS = {
  APPROVED: 'approved',
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  PENDING_DELETION: 'disabled',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
  LIMIT_EXCEEDED: 'failed',
};

export function templateStatus(metaStatus) {
  return META_STATUS[String(metaStatus || '').toUpperCase()] || 'pending';
}

export function publicAppUrl(env = process.env) {
  return String(env.PUBLIC_APP_URL || env.VITE_APP_URL || 'https://www.skyllai.com').replace(/\/$/, '');
}

/**
 * Meta stores a button's address inside the approved template, and parents
 * open it on their phones, so it must be public https. Templates submitted
 * from a laptop once got http://localhost:5173 buttons approved (2026-10-28).
 */
export function publicBaseUrlProblem(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { return 'is not a valid web address'; }
  if (url.protocol !== 'https:') return 'must start with https://';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0' || host === '::1'
    || /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return 'must be a public address, not this computer or a private network';
  }
  return null;
}

/** A sample receipt PDF, which Meta needs to approve a template with a document header. */
async function sampleReceipt() {
  const { renderFeeReceiptPdf } = await import('../crm/feeDocuments.js');
  return renderFeeReceiptPdf({
    receiptNumber: 'SAMPLE/RCP/2026-27/0001', receivedOn: '2026-10-20', amountPaise: 1200000, method: 'upi', reference: null, payerName: 'Kavita Sharma',
    allocations: [{ invoiceNumber: 'SAMPLE/INV/2026-27/0002', amountPaise: 1200000 }], unallocatedPaise: 0, reversal: null,
  }, { school: { name: 'Sample Classes' }, studentName: 'Arjun Sharma', balancePaise: 0 });
}

export async function templateRows(db, schoolId, connectionId) {
  const result = await db.execute({
    sql: 'SELECT * FROM crm_wa_templates WHERE school_id = ? AND connection_id = ? ORDER BY template_key, language',
    args: [schoolId, connectionId],
  });
  return result.rows;
}

/**
 * Submits any template this connection doesn't have yet (or that failed), then
 * reads Meta's current state. Errors are recorded per template, never thrown,
 * so one bad template can't block connecting.
 */
export async function syncTemplates(db, connection, provider, { now = () => new Date().toISOString(), baseUrl = publicAppUrl() } = {}) {
  const existing = new Map((await templateRows(db, connection.school_id, connection.id)).map((row) => [`${row.meta_name}|${row.language}`, row]));
  let headerHandle = null;
  for (const key of WA_TEMPLATE_KEYS) {
    const definition = WA_TEMPLATES[key];
    for (const language of WA_LANGUAGES) {
      const name = metaTemplateName(key, definition.version);
      const row = existing.get(`${name}|${language}`);
      if (row && row.status !== 'failed') continue;
      let status = 'pending';
      let metaId = null;
      let category = null;
      let reason = null;
      const urlProblem = definition.button ? publicBaseUrlProblem(baseUrl) : null;
      if (urlProblem) {
        status = 'failed';
        reason = `Not submitted: PUBLIC_APP_URL (${baseUrl}) ${urlProblem}, because parents open this button's link on their phones.`;
      } else {
        try {
          if (definition.header === 'document' && provider.kind === 'meta' && !headerHandle) {
            headerHandle = await provider.uploadTemplateSample({ data: await sampleReceipt(), mimeType: 'application/pdf', filename: 'sample-receipt.pdf' });
          }
          const result = await provider.submitTemplate(metaTemplatePayload(key, language, { baseUrl, headerHandle }));
          metaId = result.id || null;
          status = templateStatus(result.status);
          category = result.category || null;
        } catch (error) {
          // Already submitted earlier (for example, before a reconnect): Refresh picks up its state.
          if (/already exists/i.test(String(error.detail || error.message))) status = 'pending';
          else { status = 'failed'; reason = String(error.detail || error.reason || error.message).slice(0, 300); }
        }
      }
      const at = now();
      await db.execute({
        sql: `INSERT INTO crm_wa_templates (id, school_id, connection_id, template_key, language, version, meta_name, meta_template_id, status, category, reason, submitted_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (connection_id, meta_name, language) DO UPDATE SET
                meta_template_id = excluded.meta_template_id, status = excluded.status, category = excluded.category, reason = excluded.reason,
                submitted_at = excluded.submitted_at, updated_at = excluded.updated_at`,
        args: [`wat_${randomUUID()}`, connection.school_id, connection.id, key, language, definition.version, name, metaId, status, category, reason, at, at, at],
      });
    }
  }
  await refreshTemplates(db, connection, provider, { now });
}

/** Re-reads approval state from Meta (the test provider approves on submit). */
export async function refreshTemplates(db, connection, provider, { now = () => new Date().toISOString() } = {}) {
  const remote = await provider.listTemplates();
  if (!remote) return;
  for (const template of remote) {
    await db.execute({
      sql: `UPDATE crm_wa_templates SET status = ?, meta_template_id = COALESCE(?, meta_template_id), category = COALESCE(?, category), reason = ?, updated_at = ?
            WHERE school_id = ? AND connection_id = ? AND meta_name = ? AND language = ?`,
      args: [templateStatus(template.status), template.id || null, template.category || null, template.rejected_reason && template.rejected_reason !== 'NONE' ? String(template.rejected_reason) : null,
        now(), connection.school_id, connection.id, template.name, template.language],
    });
  }
}

/** Applies a `message_template_status_update` webhook to every connection on that WhatsApp account. */
export async function applyTemplateUpdate(db, wabaId, value, now = new Date().toISOString()) {
  const status = templateStatus(value.event);
  const reason = value.reason && value.reason !== 'NONE' ? String(value.reason).slice(0, 300) : null;
  await db.execute({
    sql: `UPDATE crm_wa_templates SET status = ?, reason = ?, meta_template_id = COALESCE(meta_template_id, ?), updated_at = ?
          WHERE meta_name = ? AND language = ?
            AND connection_id IN (SELECT id FROM crm_wa_connections WHERE waba_id = ? AND status = 'connected')`,
    args: [status, reason, value.message_template_id ? String(value.message_template_id) : null, now, value.message_template_name, value.message_template_language, wabaId],
  });
}
