// The dispatcher (CRM-020, D12), run by the OCI worker. It claims a few queued
// messages at a time with a lease (so two workers never send the same row),
// re-checks each one, and sends it through the class's provider.
//
// Never sent twice: a row is sent only by the worker holding its lease, and a
// send whose outcome is unknown (the lease ran out mid-send) becomes `failed`
// rather than being retried automatically.
import { metaTemplateMessage, metaTemplateName, renderTemplate } from '../../shared/crm/waTemplates.js';
import { DEFAULT_TIMEZONE } from '../../shared/crm/time.js';
import { blockStatements, unblockStatements } from './health.js';
import { messageCost, monthUsage, windowOpen } from './outbox.js';
import { providerFor } from './providers.js';

export const LEASE_MS = 2 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
// Minutes before attempt 2, 3, 4 and 5: about an hour in all.
const BACKOFF_MINUTES = [1, 2, 5, 15, 40];
const TEMPLATE_WAIT_MS = 10 * 60 * 1000;
const TEMPLATE_GIVE_UP_MS = 48 * 60 * 60 * 1000;
export const PROBE_EVERY_MS = 15 * 60 * 1000;

// Class-wide problems only a person can fix (reconnect): no point probing.
const NEEDS_RECONNECT = new Set(['0', '3', '10', '190', '200', '131045', '133005', '133006', '133010', 'partner_removed', 'account_deleted']);

const kinds = new Map();

/**
 * Per-kind hooks: `relevant(db, message)` returns a reason to cancel (the fee
 * was paid, the student was marked present) or null; `prepare(db, message,
 * provider)` returns `{ linkToken, documentId, documentName }` for templates
 * with a link button or a document header.
 */
export function registerKind(kind, hooks) {
  kinds.set(kind, hooks);
}

const iso = (ms) => new Date(ms).toISOString();

async function finish(db, message, workerId, fields, now) {
  const columns = Object.keys(fields);
  await db.execute({
    sql: `UPDATE crm_comms_messages SET ${columns.map((column) => `${column} = ?`).join(', ')}, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
    args: [...columns.map((column) => fields[column]), iso(now), message.id, workerId],
  });
}

const cancel = (reason) => ({ status: 'cancelled', status_reason: reason });
const fail = (code, reason, now) => ({ status: 'failed', status_code: code, status_reason: reason, failed_at: iso(now) });

/** Messages left in `sending` by a worker that stopped mid-send: their outcome is unknown. */
export async function reclaimExpired(db, now) {
  const result = await db.execute({
    sql: `UPDATE crm_comms_messages SET status = 'failed', status_code = 'unconfirmed',
            status_reason = 'Skyll could not confirm whether WhatsApp accepted this message, so it was not sent again. Use Retry if it is still needed.',
            failed_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE status = 'sending' AND lease_expires_at < ?`,
    args: [iso(now), iso(now), iso(now)],
  });
  return Number(result.rowsAffected || 0);
}

export async function claim(db, workerId, limit, now) {
  const result = await db.execute({
    sql: `UPDATE crm_comms_messages SET status = 'sending', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE id IN (
            SELECT id FROM crm_comms_messages
            WHERE status = 'queued' AND via = 'api' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY created_at LIMIT ?)
            AND status = 'queued'
          RETURNING *`,
    args: [workerId, iso(now + LEASE_MS), iso(now), iso(now), limit],
  });
  return result.rows;
}

async function connectionFor(db, message) {
  if (!message.connection_id) return null;
  return (await db.execute({ sql: 'SELECT * FROM crm_wa_connections WHERE id = ? AND school_id = ?', args: [message.connection_id, message.school_id] })).rows[0] || null;
}

async function schoolSettings(db, schoolId) {
  const [settings, school] = await Promise.all([
    db.execute({ sql: 'SELECT monthly_limit_paise FROM crm_wa_settings WHERE school_id = ?', args: [schoolId] }),
    db.execute({ sql: 'SELECT timezone FROM schools WHERE id = ?', args: [schoolId] }),
  ]);
  const limit = settings.rows[0]?.monthly_limit_paise;
  return { limitPaise: limit === null || limit === undefined ? null : Number(limit), timeZone: school.rows[0]?.timezone || DEFAULT_TIMEZONE };
}

async function contactProblem(db, message) {
  if (!message.contact_id) return null;
  const contact = (await db.execute({
    sql: 'SELECT phone_e164, whatsapp_opted_in, anonymised_at, archived_at FROM crm_contacts WHERE id = ? AND school_id = ?',
    args: [message.contact_id, message.school_id],
  })).rows[0];
  if (!contact || contact.anonymised_at || contact.archived_at) return 'The parent’s details were removed';
  if (contact.phone_e164 !== message.phone_e164) return 'The parent’s phone number changed';
  // The STOP acknowledgement is the one message sent after consent is withdrawn.
  if (message.kind !== 'stop_ack' && Number(contact.whatsapp_opted_in) !== 1) return 'The parent has not agreed to WhatsApp messages (or replied STOP)';
  return null;
}

async function templateState(db, message) {
  const result = await db.execute({
    sql: 'SELECT status, reason FROM crm_wa_templates WHERE connection_id = ? AND meta_name = ? AND language = ?',
    args: [message.connection_id, metaTemplateName(message.template_key, message.template_version), message.template_language],
  });
  return result.rows[0] || { status: 'pending' };
}

/** Whether a billable message would take this month past the class's limit (D15). */
export async function overLimit(db, message, cost, { now, settings }) {
  if (!settings.limitPaise || !cost.millipaise) return false;
  const usage = await monthUsage(db, message.school_id, { now, timeZone: settings.timeZone });
  return usage.costMillipaise + cost.millipaise > settings.limitPaise * 1000;
}

export function limitReason(limitPaise) {
  return `This month’s WhatsApp limit (₹${(limitPaise / 100).toLocaleString('en-IN')}) is reached. Raise it in Settings → WhatsApp, or messages wait until next month.`;
}

/** Re-checks and sends one claimed message. Returns the outcome for logging. */
export async function sendOne(db, message, { workerId, now = Date.now(), providerFactory = providerFor, probe = false } = {}) {
  const connection = await connectionFor(db, message);
  if (!connection || connection.status !== 'connected') {
    await finish(db, message, workerId, cancel('WhatsApp was disconnected'), now);
    return 'cancelled';
  }
  if (connection.health === 'blocked' && !probe) {
    // Waiting doesn't use up an attempt.
    await finish(db, message, workerId, { status: 'held', attempts: Math.max(0, Number(message.attempts) - 1), status_reason: connection.health_reason }, now);
    return 'held';
  }
  const problem = await contactProblem(db, message);
  if (problem) { await finish(db, message, workerId, cancel(problem), now); return 'cancelled'; }
  const hooks = kinds.get(message.kind) || {};
  const irrelevant = hooks.relevant ? await hooks.relevant(db, message, { now }) : null;
  if (irrelevant) { await finish(db, message, workerId, cancel(irrelevant), now); return 'cancelled'; }

  if (message.template_key) {
    const template = await templateState(db, message);
    if (template.status === 'pending') {
      if (now - Date.parse(message.created_at) > TEMPLATE_GIVE_UP_MS) {
        await finish(db, message, workerId, fail('template_pending', 'Meta has not approved this message’s wording yet', now), now);
        return 'failed';
      }
      await finish(db, message, workerId, { status: 'queued', attempts: Math.max(0, Number(message.attempts) - 1), next_attempt_at: iso(now + TEMPLATE_WAIT_MS), status_reason: 'Waiting for Meta to approve the wording' }, now);
      return 'waiting';
    }
    if (template.status !== 'approved') {
      await finish(db, message, workerId, fail(`template_${template.status}`, `Meta has ${template.status === 'rejected' ? 'rejected' : template.status} this message’s wording${template.reason ? ` (${template.reason})` : ''}`, now), now);
      return 'failed';
    }
  } else if (message.kind !== 'stop_ack' && !(await windowOpen(db, message.school_id, message.connection_id, message.phone_e164, now))) {
    await finish(db, message, workerId, fail('131047', 'More than 24 hours since the parent last messaged, so free text is not allowed. Use Send from my phone.', now), now);
    return 'failed';
  }

  const settings = await schoolSettings(db, message.school_id);
  const usage = message.template_key ? null : await monthUsage(db, message.school_id, { now, timeZone: settings.timeZone });
  const cost = messageCost(message.template_key, usage);
  if (await overLimit(db, message, cost, { now, settings })) {
    await db.batch([
      ...blockStatements(connection, { code: 'monthly_limit', reason: limitReason(settings.limitPaise) }, iso(now)),
      {
        sql: `UPDATE crm_comms_messages SET status = 'held', attempts = MAX(0, attempts - 1), status_reason = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND lease_owner = ?`,
        args: [limitReason(settings.limitPaise), iso(now), message.id, workerId],
      },
    ], 'write');
    return 'held';
  }

  let provider;
  let result;
  const refreshed = {};
  try {
    provider = providerFactory(connection);
    let payload;
    if (message.template_key) {
      // `prepare` adds the link and document, and may refresh amounts that changed since queueing.
      const prepared = hooks.prepare ? await hooks.prepare(db, message, provider, { now }) : {};
      let vars = JSON.parse(message.vars_json || '{}');
      if (prepared.vars) {
        vars = prepared.vars;
        refreshed.vars_json = JSON.stringify(vars);
        refreshed.body_text = renderTemplate(message.template_key, message.template_language, vars);
      }
      payload = { type: 'template', template: metaTemplateMessage(message.template_key, message.template_language, vars, prepared) };
    } else {
      payload = { type: 'text', text: { body: message.body_text, preview_url: false } };
    }
    result = await provider.send({ to: String(message.phone_e164).replace(/^\+/, ''), message: payload });
  } catch (error) {
    return failSend(db, message, connection, error, { workerId, now });
  }

  const delivered = result.simulatedStatus === 'delivered';
  await finish(db, message, workerId, {
    ...refreshed,
    status: delivered ? 'delivered' : 'sent',
    provider_message_id: result.id,
    status_code: null,
    status_reason: null,
    next_attempt_at: null,
    sent_at: iso(now),
    delivered_at: delivered ? iso(now) : null,
    pricing_category: cost.category,
    cost_millipaise: cost.millipaise,
  }, now);
  return 'sent';
}

async function failSend(db, message, connection, error, { workerId, now }) {
  const kind = error?.kind || 'temporary';
  const code = error?.code || null;
  const reason = error?.reason || 'Could not send the message';
  if (kind === 'temporary') {
    if (Number(message.attempts) >= MAX_ATTEMPTS) {
      await finish(db, message, workerId, fail(code || 'temporary', `${reason}. Gave up after ${MAX_ATTEMPTS} attempts.`.replace('; Skyll will try again shortly', ''), now), now);
      return 'failed';
    }
    const wait = BACKOFF_MINUTES[Math.min(Number(message.attempts) - 1, BACKOFF_MINUTES.length - 1)] * 60_000;
    await finish(db, message, workerId, { status: 'queued', status_code: code, status_reason: reason, next_attempt_at: iso(now + wait) }, now);
    return 'retry';
  }
  if (kind === 'class') {
    // Everything for this class waits; this message waits too, without using an attempt.
    await db.batch([
      ...blockStatements(connection, { code, reason }, iso(now)),
      {
        sql: `UPDATE crm_comms_messages SET status = 'held', attempts = MAX(0, attempts - 1), status_code = ?, status_reason = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND lease_owner = ?`,
        args: [code, reason, iso(now), message.id, workerId],
      },
      { sql: 'UPDATE crm_wa_connections SET health_at = ? WHERE id = ?', args: [iso(now), connection.id] },
    ], 'write');
    return 'held';
  }
  if (kind === 'template') {
    await db.execute({
      sql: `UPDATE crm_wa_templates SET status = ?, updated_at = ? WHERE connection_id = ? AND meta_name = ? AND language = ?`,
      args: [code === '132016' ? 'disabled' : code === '132001' ? 'pending' : 'paused', iso(now), connection.id, metaTemplateName(message.template_key, message.template_version), message.template_language],
    });
  }
  await finish(db, message, workerId, fail(code || kind, reason, now), now);
  return 'failed';
}

/** Puts a connection's held messages back in the queue (each is re-checked before sending). */
export function releaseHeldStatement(connectionId, now) {
  return {
    sql: `UPDATE crm_comms_messages SET status = 'queued', next_attempt_at = NULL, status_reason = NULL, updated_at = ? WHERE connection_id = ? AND status = 'held'`,
    args: [iso(now), connectionId],
  };
}

/**
 * Re-checks blocked connections every 15 minutes (D12). A reached monthly
 * limit clears itself when the limit is raised or the month turns. Other
 * problems are tested by trying the oldest held message once; if it sends,
 * the block lifts and the rest follow. Problems that need a reconnect wait.
 */
export async function probeBlocked(db, { workerId, now = Date.now(), providerFactory = providerFor } = {}) {
  const blocked = (await db.execute({
    sql: "SELECT * FROM crm_wa_connections WHERE status = 'connected' AND health = 'blocked' AND (health_at IS NULL OR health_at < ?)",
    args: [iso(now - PROBE_EVERY_MS)],
  })).rows;
  let lifted = 0;
  for (const connection of blocked) {
    if (NEEDS_RECONNECT.has(String(connection.health_code))) continue;
    if (connection.health_code === 'monthly_limit') {
      const settings = await schoolSettings(db, connection.school_id);
      const usage = await monthUsage(db, connection.school_id, { now, timeZone: settings.timeZone });
      if (!settings.limitPaise || usage.costMillipaise < settings.limitPaise * 1000) {
        await db.batch([...unblockStatements(connection, iso(now)), releaseHeldStatement(connection.id, now)], 'write');
        lifted += 1;
      } else {
        await db.execute({ sql: 'UPDATE crm_wa_connections SET health_at = ? WHERE id = ?', args: [iso(now), connection.id] });
      }
      continue;
    }
    await db.execute({ sql: 'UPDATE crm_wa_connections SET health_at = ? WHERE id = ?', args: [iso(now), connection.id] });
    // Messages that turn out to be no longer needed (cancelled) say nothing about
    // the class's problem, so try the next one, a few at most.
    for (let tries = 0; tries < 5; tries += 1) {
      const [oldest] = (await db.execute({
        sql: `UPDATE crm_comms_messages SET status = 'sending', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
              WHERE id = (SELECT id FROM crm_comms_messages WHERE connection_id = ? AND status = 'held' ORDER BY created_at LIMIT 1) AND status = 'held'
              RETURNING *`,
        args: [workerId, iso(now + LEASE_MS), iso(now), connection.id],
      })).rows;
      if (!oldest) break;
      const outcome = await sendOne(db, oldest, { workerId, now, providerFactory, probe: true });
      if (outcome === 'held') break;
      if (outcome === 'sent') {
        const fresh = (await db.execute({ sql: 'SELECT * FROM crm_wa_connections WHERE id = ?', args: [connection.id] })).rows[0];
        await db.batch([...unblockStatements(fresh, iso(now)), releaseHeldStatement(connection.id, now)], 'write');
        lifted += 1;
        break;
      }
    }
  }
  return lifted;
}

/** One dispatcher pass: reclaim, claim up to `limit`, send each. */
export async function dispatchOnce(db, { workerId, limit = 10, now = Date.now(), providerFactory = providerFor } = {}) {
  const reclaimed = await reclaimExpired(db, now);
  const claimed = await claim(db, workerId, limit, now);
  const outcomes = {};
  for (const message of claimed) {
    let outcome;
    try {
      outcome = await sendOne(db, message, { workerId, now, providerFactory });
    } catch (error) {
      // Unexpected (a database hiccup): leave the lease to expire into "unconfirmed" only if we may have sent.
      console.error(JSON.stringify({ event: 'wa_dispatch_error', messageId: message.id, error: String(error?.message || error) }));
      outcome = 'error';
    }
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
  }
  return { reclaimed, claimed: claimed.length, outcomes };
}
