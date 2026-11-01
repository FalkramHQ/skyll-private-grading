// Settings → WhatsApp (CRM M2 phase 2 S1, D2/D6/D7/D11/D15): connect the
// class's own number, the class details that fill template blanks, the
// automatic-message switches, the reminder schedule and a monthly limit.
//
// Connecting stores the class's business token encrypted (server/comms/
// secrets.js); no response ever includes it. Only one number is connected per
// school; connecting another replaces it.
import { randomInt, randomUUID } from 'node:crypto';
import {
  AUTO_MESSAGES, SCHEDULE_FIELDS, connectBody, connectManualBody, disconnectBody, waSettingsBody,
} from '../../shared/crm/comms.js';
import { WA_TEMPLATES, WA_TEMPLATE_KEYS } from '../../shared/crm/waTemplates.js';
import { ProviderError } from '../comms/errors.js';
import { exchangeCode, metaConfig, phoneNumberInfo, registerNumber, subscribeApp, wabaPhoneNumbers } from '../comms/meta.js';
import { providerFor } from '../comms/providers.js';
import { encryptSecret, hasSecretKey } from '../comms/secrets.js';
import { syncTemplates, templateRows } from '../comms/templates.js';
import { releaseHeldStatement } from '../comms/dispatcher.js';
import { unblockStatements } from '../comms/health.js';
import { monthStartIso, monthUsage } from '../comms/outbox.js';
import { withGstPaise } from '../../shared/crm/waPricing.js';
import { DEFAULT_TIMEZONE } from '../../shared/crm/time.js';
import { auditStatement } from './audit.js';
import { versionConflict } from './concurrency.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { feeSettings } from './feePlans.js';

export { connectBody, connectManualBody, disconnectBody, waSettingsBody };

// Lets tests stub Meta's Graph API.
let fetchImpl = (...args) => fetch(...args);
export function setWhatsAppFetch(impl) { fetchImpl = impl || ((...args) => fetch(...args)); }

/** The number must belong to the WhatsApp account it was chosen with (both checked with the class's own token). */
async function assertNumberInAccount(token, wabaId, phoneNumberId, options) {
  const numbers = await wabaPhoneNumbers(token, wabaId, options);
  if (!(numbers.data || []).some((number) => String(number.id) === phoneNumberId)) {
    throw new CrmHttpError(422, 'validation_failed', 'That number is not part of the chosen WhatsApp account', [{ path: 'phoneNumberId', message: 'Not in this WhatsApp account' }]);
  }
}

const unavailable = () => new CrmHttpError(503, 'whatsapp_unavailable', 'WhatsApp isn’t set up on this server yet. Ask Skyll support.');

function providerProblem(error) {
  if (error instanceof ProviderError) return new CrmHttpError(502, 'whatsapp_error', error.reason, error.detail ? [{ path: 'meta', message: error.detail }] : undefined);
  return error;
}

// ---------------------------------------------------------------- loading --

export async function activeConnection(db, schoolId) {
  const result = await db.execute({ sql: "SELECT * FROM crm_wa_connections WHERE school_id = ? AND status = 'connected' LIMIT 1", args: [schoolId] });
  return result.rows[0] || null;
}

function serializeConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    mode: row.mode,
    displayPhone: row.display_phone || null,
    verifiedName: row.verified_name || null,
    coexistence: Number(row.coexistence) === 1,
    health: row.health,
    healthCode: row.health_code || null,
    healthReason: row.health_reason || null,
    healthAt: row.health_at || null,
    qualityRating: row.quality_rating || null,
    connectedAt: row.connected_at,
    version: Number(row.version),
  };
}

const bool = (value) => Number(value) === 1;

/** Saved settings, or defaults (version 0) using the name on fee documents. */
export async function waSettings(db, scope) {
  const saved = (await db.execute({ sql: 'SELECT * FROM crm_wa_settings WHERE school_id = ?', args: [scope.schoolId] })).rows[0];
  if (saved) {
    return {
      language: saved.language,
      senderName: saved.sender_name || '',
      contactLine: saved.contact_line || '',
      paymentInstructions: saved.payment_instructions || '',
      auto: Object.fromEntries(AUTO_MESSAGES.map((item) => [item.key, bool(saved[item.column])])),
      schedule: Object.fromEntries(SCHEDULE_FIELDS.map((field) => [field.key, Number(saved[field.column])])),
      monthlyLimitPaise: saved.monthly_limit_paise === null ? null : Number(saved.monthly_limit_paise),
      version: Number(saved.version),
      saved: true,
    };
  }
  const fees = await feeSettings(db, scope);
  return {
    language: 'en',
    senderName: (fees.headerName || scope.schoolName || '').slice(0, 60),
    contactLine: '',
    paymentInstructions: '',
    auto: Object.fromEntries(AUTO_MESSAGES.map((item) => [item.key, true])),
    schedule: Object.fromEntries(SCHEDULE_FIELDS.map((field) => [field.key, field.fallback])),
    monthlyLimitPaise: null,
    version: 0,
    saved: false,
  };
}

function signupConfig(env = process.env) {
  const config = metaConfig(env);
  return {
    available: Boolean(config.appId && config.configId && config.appSecret && hasSecretKey(env)),
    appId: config.appId,
    configId: config.configId,
    graphVersion: config.graphVersion,
    solutionId: config.solutionId,
  };
}

async function templateList(db, scope, connection) {
  if (!connection) return [];
  const rows = await templateRows(db, scope.schoolId, connection.id);
  return rows
    .filter((row) => WA_TEMPLATES[row.template_key])
    .sort((a, b) => WA_TEMPLATE_KEYS.indexOf(a.template_key) - WA_TEMPLATE_KEYS.indexOf(b.template_key) || a.language.localeCompare(b.language))
    .map((row) => ({
      key: row.template_key,
      label: WA_TEMPLATES[row.template_key].label,
      language: row.language,
      version: Number(row.version),
      status: row.status,
      category: row.category || null,
      reason: row.reason || null,
    }));
}

export async function getWhatsApp({ db, scope }) {
  const connection = await activeConnection(db, scope.schoolId);
  return {
    connection: serializeConnection(connection),
    templates: await templateList(db, scope, connection),
    settings: await waSettings(db, scope),
    signup: signupConfig(),
    // Platform staff may connect Meta's test number by hand, or the test provider.
    platform: Boolean(scope.support),
  };
}

// --------------------------------------------------------------- settings --

const SETTING_COLUMNS = [
  ['language', 'language'], ['senderName', 'sender_name'], ['contactLine', 'contact_line'], ['paymentInstructions', 'payment_instructions'],
  ...AUTO_MESSAGES.map((item) => [`auto.${item.key}`, item.column]),
  ...SCHEDULE_FIELDS.map((field) => [`schedule.${field.key}`, field.column]),
  ['monthlyLimitPaise', 'monthly_limit_paise'],
];

function settingValue(settings, path) {
  const value = path.split('.').reduce((current, key) => current?.[key], settings);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value === '' || value === undefined ? null : value;
}

export async function saveWhatsAppSettings({ db, scope, input }) {
  const body = input.body;
  const current = await waSettings(db, scope);
  if (current.version !== body.expectedVersion) throw versionConflict(current.version);
  const values = SETTING_COLUMNS.map(([path]) => settingValue(body, path));
  const fields = SETTING_COLUMNS.filter(([path]) => String(settingValue(current, path) ?? '') !== String(settingValue(body, path) ?? '')).map(([path]) => path.split('.').pop());
  const now = new Date().toISOString();
  const columns = SETTING_COLUMNS.map(([, column]) => column);
  const write = body.expectedVersion === 0
    ? {
      sql: `INSERT INTO crm_wa_settings (school_id, ${columns.join(', ')}, updated_by, created_at, updated_at)
            SELECT ?, ${columns.map(() => '?').join(', ')}, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM crm_wa_settings WHERE school_id = ?)`,
      args: [scope.schoolId, ...values, scope.actor.user_id || null, now, now, scope.schoolId],
    }
    : {
      sql: `UPDATE crm_wa_settings SET ${columns.map((column) => `${column} = ?`).join(', ')}, updated_by = ?, version = version + 1, updated_at = ?
            WHERE school_id = ? AND version = ?`,
      args: [...values, scope.actor.user_id || null, now, scope.schoolId, body.expectedVersion],
    };
  const results = await db.batch([
    write,
    auditStatement(scope, { action: 'wa_settings.changed', entityId: scope.schoolId, summary: { fields: fields.length ? fields : ['senderName'] }, onlyIfChanged: true, now }),
  ], 'write');
  if (!Number(results[0].rowsAffected)) throw versionConflict((await waSettings(db, scope)).version);
  await liftLimitIfUnder(db, scope, body.monthlyLimitPaise);
  return getWhatsApp({ db, scope });
}

/** A raised (or removed) monthly limit releases held messages at once (D15). */
async function liftLimitIfUnder(db, scope, limitPaise) {
  const connection = await activeConnection(db, scope.schoolId);
  if (connection?.health !== 'blocked' || connection.health_code !== 'monthly_limit') return;
  const usage = await monthUsage(db, scope.schoolId, { timeZone: scope.timezone || DEFAULT_TIMEZONE });
  if (limitPaise !== null && usage.costMillipaise >= limitPaise * 1000) return;
  const now = new Date().toISOString();
  await db.batch([...unblockStatements(connection, now), releaseHeldStatement(connection.id, Date.parse(now))], 'write');
}

/** This month's messages and estimated cost, including GST (D15). */
export async function getWhatsAppUsage({ db, scope }) {
  const timeZone = scope.timezone || DEFAULT_TIMEZONE;
  const [usage, settings] = await Promise.all([monthUsage(db, scope.schoolId, { timeZone }), waSettings(db, scope)]);
  return {
    since: monthStartIso(Date.now(), timeZone),
    counts: usage.counts,
    messages: usage.counts.utility + usage.counts.service,
    estimatedPaise: withGstPaise(usage.costMillipaise),
    limitPaise: settings.monthlyLimitPaise,
  };
}

// ------------------------------------------------------------- connecting --

/**
 * Replaces any connected number with this one, in one batch with its audit
 * event. Messages still waiting for the old number are cancelled (S2).
 */
async function storeConnection(db, scope, fields) {
  const now = new Date().toISOString();
  const previous = await activeConnection(db, scope.schoolId);
  const connectionId = `wac_${randomUUID()}`;
  const statements = [];
  if (previous) {
    statements.push({
      sql: `UPDATE crm_wa_connections SET status = 'disconnected', token_enc = NULL, pin_enc = NULL, disconnected_by = ?, disconnected_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND status = 'connected'`,
      args: [scope.actor.user_id || null, now, now, previous.id, scope.schoolId],
    });
    statements.push(...await cancelWaiting(db, scope.schoolId, previous.id, 'The class connected a different WhatsApp number', now));
  }
  // The same number connected before (or by another school) is released first,
  // so webhooks keep mapping to exactly one school.
  statements.push({
    sql: `UPDATE crm_wa_connections SET status = 'disconnected', token_enc = NULL, pin_enc = NULL, disconnected_at = ?, version = version + 1, updated_at = ?
          WHERE phone_number_id = ? AND status = 'connected' AND school_id != ?`,
    args: [now, now, fields.phoneNumberId, scope.schoolId],
  });
  statements.push({
    sql: `INSERT INTO crm_wa_connections (id, school_id, provider, mode, status, waba_id, phone_number_id, business_id, display_phone, verified_name, coexistence,
            token_enc, pin_enc, quality_rating, connected_by, connected_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [connectionId, scope.schoolId, fields.provider, fields.mode, fields.wabaId || null, fields.phoneNumberId, fields.businessId || null, fields.displayPhone || null,
      fields.verifiedName || null, fields.coexistence ? 1 : 0, fields.tokenEnc || null, fields.pinEnc || null, fields.qualityRating || null, scope.actor.user_id || null, now, now, now],
  });
  statements.push(auditStatement(scope, {
    action: 'wa_connection.changed', entityId: scope.schoolId, summary: { change: 'connected', connectionId, mode: fields.mode, coexistence: Boolean(fields.coexistence) }, now,
  }));
  await db.batch(statements, 'write');
  return (await db.execute({ sql: 'SELECT * FROM crm_wa_connections WHERE id = ?', args: [connectionId] })).rows[0];
}

/**
 * Statements that cancel a connection's queued and held messages (S2 adds the
 * outbox; before migration 086 there is nothing to cancel).
 */
export async function cancelWaiting(db, schoolId, connectionId, reason, now) {
  const outbox = await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'crm_comms_messages'", args: [] });
  if (!outbox.rows.length) return [];
  return [{
    sql: `UPDATE crm_comms_messages SET status = 'cancelled', status_reason = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE school_id = ? AND connection_id = ? AND status IN ('queued', 'held')`,
    args: [reason, now, schoolId, connectionId],
  }];
}

async function afterConnect(db, scope, connection) {
  try {
    await syncTemplates(db, connection, providerFor(connection, { fetchImpl }));
  } catch (error) {
    // Template problems show per template; connecting itself succeeded.
    console.warn(JSON.stringify({ event: 'wa_template_sync_failed', schoolId: scope.schoolId, error: String(error?.reason || error?.message || error) }));
  }
  return getWhatsApp({ db, scope });
}

/** Embedded Signup finished in the browser: exchange the code and set the number up. */
export async function connectWhatsApp({ db, scope, input }) {
  if (!signupConfig().available) throw unavailable();
  const body = input.body;
  const options = { fetchImpl };
  try {
    const token = await exchangeCode(body.code, options);
    await assertNumberInAccount(token, body.wabaId, body.phoneNumberId, options);
    const info = await phoneNumberInfo(token, body.phoneNumberId, options);
    await subscribeApp(token, body.wabaId, options);
    let pin = null;
    // Coexistence numbers stay registered to the WhatsApp Business app.
    if (!body.coexistence) {
      pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await registerNumber(token, body.phoneNumberId, pin, options);
    }
    const connection = await storeConnection(db, scope, {
      provider: 'meta', mode: 'embedded', wabaId: body.wabaId, phoneNumberId: body.phoneNumberId, businessId: body.businessId, coexistence: body.coexistence,
      displayPhone: info.display_phone_number, verifiedName: info.verified_name, qualityRating: info.quality_rating,
      tokenEnc: encryptSecret(token), pinEnc: pin ? encryptSecret(pin) : null,
    });
    return afterConnect(db, scope, connection);
  } catch (error) {
    throw providerProblem(error);
  }
}

/** Platform staff only: Meta's test number (or a number set up by hand) with a system-user token. */
export async function connectWhatsAppManual({ db, scope, input }) {
  if (!scope.support) throw crmErrors.forbidden();
  if (!hasSecretKey()) throw unavailable();
  const body = input.body;
  const options = { fetchImpl };
  try {
    await assertNumberInAccount(body.accessToken, body.wabaId, body.phoneNumberId, options);
    const info = await phoneNumberInfo(body.accessToken, body.phoneNumberId, options);
    await subscribeApp(body.accessToken, body.wabaId, options);
    const connection = await storeConnection(db, scope, {
      provider: 'meta', mode: 'manual', wabaId: body.wabaId, phoneNumberId: body.phoneNumberId,
      displayPhone: info.display_phone_number, verifiedName: info.verified_name, qualityRating: info.quality_rating, tokenEnc: encryptSecret(body.accessToken),
    });
    return afterConnect(db, scope, connection);
  } catch (error) {
    throw providerProblem(error);
  }
}

/** Platform staff only: the test provider, for a demo school that has no real number (D13). */
export async function connectWhatsAppTest({ db, scope }) {
  if (!scope.support) throw crmErrors.forbidden();
  const connection = await storeConnection(db, scope, {
    provider: 'test', mode: 'test', phoneNumberId: `test_${scope.schoolId}`, displayPhone: '+91 00000 00000', verifiedName: scope.schoolName || 'Demo', qualityRating: 'GREEN',
  });
  return afterConnect(db, scope, connection);
}

export async function disconnectWhatsApp({ db, scope, input }) {
  const connection = await activeConnection(db, scope.schoolId);
  if (!connection) throw crmErrors.notFound();
  if (Number(connection.version) !== input.body.expectedVersion) throw versionConflict(Number(connection.version));
  const now = new Date().toISOString();
  const results = await db.batch([
    {
      sql: `UPDATE crm_wa_connections SET status = 'disconnected', token_enc = NULL, pin_enc = NULL, disconnected_by = ?, disconnected_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND status = 'connected' AND version = ?`,
      args: [scope.actor.user_id || null, now, now, connection.id, scope.schoolId, input.body.expectedVersion],
    },
    ...await cancelWaiting(db, scope.schoolId, connection.id, 'WhatsApp was disconnected', now),
    auditStatement(scope, { action: 'wa_connection.changed', entityId: scope.schoolId, summary: { change: 'disconnected', connectionId: connection.id, mode: connection.mode }, onlyIfChanged: false, now }),
  ], 'write');
  if (!Number(results[0].rowsAffected)) throw versionConflict(Number((await activeConnection(db, scope.schoolId))?.version || 0));
  return getWhatsApp({ db, scope });
}

/** Submits anything missing or failed, then re-reads Meta's approval state. */
export async function refreshWhatsAppTemplates({ db, scope }) {
  const connection = await activeConnection(db, scope.schoolId);
  if (!connection) throw crmErrors.notFound();
  try {
    await syncTemplates(db, connection, providerFor(connection, { fetchImpl }));
  } catch (error) {
    throw providerProblem(error);
  }
  return getWhatsApp({ db, scope });
}
