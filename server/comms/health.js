// A class's WhatsApp health (D12). When nothing can send for the class (the
// number is disconnected, payment failed, the account is restricted, or the
// monthly limit is reached) the connection is `blocked`: messages wait as
// `held`, and a banner explains what to fix. Changes are audited once.
import { auditStatement } from '../crm/audit.js';
import { systemScope } from './system.js';

/** Statements that block a connection (no-op when already blocked with the same code). */
export function blockStatements(connection, { code, reason }, now = new Date().toISOString()) {
  return [
    {
      sql: `UPDATE crm_wa_connections SET health = 'blocked', health_code = ?, health_reason = ?, health_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND status = 'connected' AND NOT (health = 'blocked' AND health_code IS ?)`,
      args: [String(code ?? 'unknown'), reason, now, now, connection.id, String(code ?? 'unknown')],
    },
    auditStatement(systemScope(connection.school_id), {
      action: 'wa_connection.changed', entityId: connection.school_id, summary: { change: 'blocked', connectionId: connection.id, code: String(code ?? 'unknown') }, onlyIfChanged: true, now,
    }),
  ];
}

export function unblockStatements(connection, now = new Date().toISOString()) {
  return [
    {
      sql: `UPDATE crm_wa_connections SET health = 'ok', health_code = NULL, health_reason = NULL, health_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND status = 'connected' AND health = 'blocked'`,
      args: [now, now, connection.id],
    },
    auditStatement(systemScope(connection.school_id), {
      action: 'wa_connection.changed', entityId: connection.school_id, summary: { change: 'unblocked', connectionId: connection.id }, onlyIfChanged: true, now,
    }),
  ];
}

export async function blockConnection(db, connection, problem, now) {
  await db.batch(blockStatements(connection, problem, now), 'write');
}

export async function unblockConnection(db, connection, now) {
  await db.batch(unblockStatements(connection, now), 'write');
}
