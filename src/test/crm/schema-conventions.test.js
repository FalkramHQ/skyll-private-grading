// CRM-003 acceptance: every CRM tenant table carries a required school_id,
// timestamps, and a school-first index; history tables are append-only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

const require = createRequire(import.meta.url);
const MIGRATIONS = ['059_crm_access_audit', '060_crm_pipeline', '061_crm_contacts', '062_crm_leads', '065_crm_tasks', '068_crm_inquiry_settings', '075_crm_courses_rooms', '076_crm_instructors', '077_crm_timetable', '078_crm_holidays', '079_crm_session_attendance', '081_crm_fee_plans', '082_crm_invoices', '083_crm_payments', '084_crm_fee_guards', '085_crm_whatsapp', '086_crm_comms_messages', '087_crm_access_links'];

// Immutable history rows are never updated, so they have no updated_at.
const APPEND_ONLY = ['crm_audit_events', 'crm_lead_stage_events', 'crm_task_events', 'crm_payments', 'crm_payment_allocations', 'crm_invoice_lines'];
const INSERT_ONLY = [...APPEND_ONLY, 'crm_idempotency_keys', 'crm_payment_requests', 'crm_comms_subjects'];

let dir;
let db;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'crm-schema-'));
  db = createClient({ url: `file:${path.join(dir, 'schema.db')}` });
  const statements = MIGRATIONS.flatMap((name) => require(`../../../scripts/migrations/${name}.cjs`).statements);
  // 075 indexes the existing canonical `batches` table.
  await db.execute('CREATE TABLE batches (id TEXT PRIMARY KEY, school_id TEXT, status TEXT)');
  await db.batch(statements, 'write');
  // Re-running every migration statement is a no-op (idempotent DDL).
  await db.batch(statements, 'write');
});

afterAll(async () => {
  db?.close();
  await rm(dir, { recursive: true, force: true });
});

async function crmTables() {
  const result = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'crm_%' ORDER BY name");
  return result.rows.map((row) => row.name);
}

describe('CRM schema conventions', () => {
  it('creates the full CRM table set', async () => {
    expect(await crmTables()).toEqual([
      'crm_access_links', 'crm_audit_events', 'crm_availability_exceptions', 'crm_availability_windows', 'crm_batch_instructors', 'crm_batch_settings', 'crm_capability_grants', 'crm_class_sessions', 'crm_comms_inbound', 'crm_comms_messages', 'crm_comms_subjects', 'crm_contacts', 'crm_courses', 'crm_doc_counters', 'crm_entity_tags', 'crm_fee_plan_items', 'crm_fee_plans', 'crm_fee_settings', 'crm_guardian_links', 'crm_holidays',
      'crm_idempotency_keys', 'crm_inquiry_settings', 'crm_invoice_lines', 'crm_invoices', 'crm_lead_sources', 'crm_lead_stage_events', 'crm_leads', 'crm_notes', 'crm_payment_allocations', 'crm_payment_requests', 'crm_payments',
      'crm_pipeline_stages', 'crm_pipelines', 'crm_reminder_pauses', 'crm_rooms', 'crm_session_attendance', 'crm_student_profiles', 'crm_tags', 'crm_task_events', 'crm_tasks', 'crm_timetable_rules', 'crm_wa_connections', 'crm_wa_settings', 'crm_wa_templates',
    ]);
  });

  it('gives every table a required school_id and timestamps', async () => {
    for (const table of await crmTables()) {
      const columns = Object.fromEntries((await db.execute(`PRAGMA table_info(${table})`)).rows.map((row) => [row.name, row]));
      expect(columns.school_id?.notnull, `${table}.school_id NOT NULL`).toBe(1);
      expect(columns.created_at?.notnull, `${table}.created_at NOT NULL`).toBe(1);
      if (!INSERT_ONLY.includes(table)) expect(columns.updated_at?.notnull, `${table}.updated_at NOT NULL`).toBe(1);
    }
  });

  it('indexes every table by school first', async () => {
    for (const table of await crmTables()) {
      const indexes = (await db.execute(`PRAGMA index_list(${table})`)).rows;
      const leading = [];
      for (const index of indexes) {
        const columns = (await db.execute(`PRAGMA index_info(${index.name})`)).rows;
        leading.push(columns.sort((a, b) => a.seqno - b.seqno)[0]?.name);
      }
      expect(leading, `${table} needs an index led by school_id`).toContain('school_id');
    }
  });

  it('protects history tables with UPDATE and DELETE triggers', async () => {
    const triggers = (await db.execute("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'")).rows;
    for (const table of APPEND_ONLY) {
      // Ledger tables also carry insert-time checks (083); only these two may block changes.
      expect(triggers.filter((trigger) => trigger.tbl_name === table).map((trigger) => trigger.name)).toEqual(expect.arrayContaining([`${table}_no_delete`, `${table}_no_update`]));
    }
  });

  it('enforces the fee ledger rules in the database (083)', async () => {
    const ledger = createClient({ url: `file:${path.join(dir, 'ledger.db')}` });
    await ledger.batch(['081_crm_fee_plans', '082_crm_invoices', '083_crm_payments', '084_crm_fee_guards'].flatMap((name) => require(`../../../scripts/migrations/${name}.cjs`).statements), 'write');
    const t = '2026-10-14T00:00:00.000Z';
    await ledger.batch([
      `INSERT INTO crm_invoices (id, school_id, student_id, number, fy, seq, issue_date, due_date, total_paise, bill_to_json, created_at, updated_at)
       VALUES ('inv_1', 'sch_a', 'stu_1', 'A/INV/2026-27/0001', '2026-27', 1, '2026-10-14', '2026-10-14', 1000, '{}', '${t}', '${t}'),
              ('inv_2', 'sch_a', 'stu_2', 'A/INV/2026-27/0002', '2026-27', 2, '2026-10-14', '2026-10-14', 1000, '{}', '${t}', '${t}')`,
      `INSERT INTO crm_payments (id, school_id, student_id, kind, amount_paise, received_on, method, receipt_number, fy, seq, created_at)
       VALUES ('pay_1', 'sch_a', 'stu_1', 'payment', 1500, '2026-10-14', 'cash', 'A/RCP/2026-27/0001', '2026-27', 1, '${t}')`,
    ], 'write');
    const allocate = (id, invoice, amount) => ledger.execute(`INSERT INTO crm_payment_allocations (id, school_id, payment_id, invoice_id, amount_paise, created_at) VALUES ('${id}', 'sch_a', 'pay_1', '${invoice}', ${amount}, '${t}')`);
    await expect(allocate('a0', 'inv_2', 100)).rejects.toThrow(/allocation_invalid/);
    await expect(allocate('a1', 'inv_1', 1001)).rejects.toThrow(/allocation_exceeds_invoice/);
    await allocate('a2', 'inv_1', 1000);
    await expect(allocate('a3', 'inv_1', 1)).rejects.toThrow(/allocation_exceeds_invoice/);
    await expect(allocate('a4', 'inv_1', -1001)).rejects.toThrow(/release_exceeds_allocation/);
    await expect(ledger.execute("UPDATE crm_invoices SET status = 'void', void_reason = 'x', voided_at = 'now' WHERE id = 'inv_1'")).rejects.toThrow(/invoice_has_payments/);
    await expect(ledger.execute("UPDATE crm_payments SET amount_paise = 1 WHERE id = 'pay_1'")).rejects.toThrow(/append-only/);
    await expect(ledger.execute("DELETE FROM crm_payment_allocations WHERE id = 'a2'")).rejects.toThrow(/append-only/);
    await expect(ledger.execute(`INSERT INTO crm_payments (id, school_id, student_id, kind, reverses_payment_id, amount_paise, received_on, method, reason, created_at)
      VALUES ('rev_x', 'sch_a', 'stu_1', 'reversal', 'pay_1', 999, '2026-10-14', 'cash', 'Bounced', '${t}')`)).rejects.toThrow(/reversal_mismatch/);
    const reverse = (id) => ledger.execute(`INSERT INTO crm_payments (id, school_id, student_id, kind, reverses_payment_id, amount_paise, received_on, method, reason, created_at)
      VALUES ('${id}', 'sch_a', 'stu_1', 'reversal', 'pay_1', 1500, '2026-10-14', 'cash', 'Bounced', '${t}')`);
    await reverse('rev_1');
    await expect(reverse('rev_2')).rejects.toThrow(/UNIQUE/);
    await allocate('a5', 'inv_1', -1000);
    await expect(allocate('a6', 'inv_1', 500)).rejects.toThrow(/payment_reversed/);
    // 084: issued invoices only change by being voided; lines and counters are fixed.
    await expect(ledger.execute("UPDATE crm_invoices SET total_paise = 1 WHERE id = 'inv_2'")).rejects.toThrow(/never edited/);
    await expect(ledger.execute("UPDATE crm_invoices SET student_id = 'stu_1', status = 'void', void_reason = 'x', voided_at = 'now' WHERE id = 'inv_2'")).rejects.toThrow(/never edited/);
    await ledger.execute("UPDATE crm_invoices SET status = 'void', void_reason = 'Wrong student', voided_at = 'now', updated_at = 'now' WHERE id = 'inv_2'");
    await expect(ledger.execute("UPDATE crm_invoices SET status = 'issued', void_reason = NULL, voided_at = NULL WHERE id = 'inv_2'")).rejects.toThrow(/never edited/);
    await expect(ledger.execute("DELETE FROM crm_invoices WHERE id = 'inv_2'")).rejects.toThrow(/append-only/);
    await ledger.execute(`INSERT INTO crm_doc_counters (school_id, kind, fy, last_seq, created_at, updated_at) VALUES ('sch_a', 'invoice', '2026-27', 2, '${t}', '${t}')`);
    await expect(ledger.execute("UPDATE crm_doc_counters SET last_seq = 1")).rejects.toThrow(/only move forward/);
    await expect(ledger.execute('DELETE FROM crm_doc_counters')).rejects.toThrow(/never deleted/);
    ledger.close();
  });

  it('applies attendance alongside a leftover prototype crm_attendance table (FLKRM-327)', async () => {
    const legacy = createClient({ url: `file:${path.join(dir, 'legacy.db')}` });
    await legacy.execute(`CREATE TABLE crm_attendance (id TEXT PRIMARY KEY, school_id TEXT NOT NULL, student_id TEXT NOT NULL,
      batch_id TEXT, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'present', marked_at TEXT NOT NULL, marked_by TEXT)`);
    await legacy.batch(require('../../../scripts/migrations/079_crm_session_attendance.cjs').statements, 'write');
    const columns = (await legacy.execute('PRAGMA table_info(crm_session_attendance)')).rows.map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(['session_id', 'student_id', 'status', 'version']));
    legacy.close();
  });

  it('keeps foreign keys off the audit log so deletes can never cascade into it', async () => {
    expect((await db.execute('PRAGMA foreign_key_list(crm_audit_events)')).rows).toEqual([]);
  });
});
