// Fee plans and fee settings (CRM-017, CRM M2 phase 1 S1, D3/D6/D7).
//
// A plan is a reusable template; applying it copies its amounts onto new
// invoices, so editing or archiving a plan never changes invoices already
// made. Settings hold the document number prefix and the header printed on
// invoices and receipts, prefilled from the school's Skyll billing profile.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nameKey } from '../../shared/crm/classes.js';
import { feeSettingsBody, planBody, planTotal, updatePlanBody } from '../../shared/crm/fees.js';
import { auditStatement } from './audit.js';
import { assertVersionedWrite, expectedVersion, versionConflict } from './concurrency.js';
import { duplicateName } from './courses.js';
import { CrmHttpError, crmErrors } from './errors.js';

const newId = (prefix) => `${prefix}_${randomUUID()}`;
const id = z.string().trim().min(1).max(128);

export { feeSettingsBody, planBody as createPlanBody, updatePlanBody };
export const listPlansQuery = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active'),
  courseId: z.string().max(128).optional(),
});
export const planStatusBody = z.object({ planId: id, expectedVersion }).strict();

const PLAN_NAME_TAKEN = 'A fee plan with this name already exists (it may be archived)';

function serializePlan(row, items) {
  const plan = {
    id: row.id,
    name: row.name,
    course: row.course_id ? { id: row.course_id, name: row.course_name || null } : null,
    kind: row.kind,
    items: items.map((item) => ({
      id: item.id, label: item.label, amountPaise: Number(item.amount_paise), dueOffsetValue: Number(item.due_offset_value), dueOffsetUnit: item.due_offset_unit,
    })),
    monthly: row.kind === 'monthly'
      ? { amountPaise: Number(row.monthly_amount_paise), count: Number(row.monthly_count), dueDay: Number(row.monthly_due_day) }
      : null,
    description: row.description || null,
    status: row.status,
    version: Number(row.version),
  };
  return { ...plan, totalPaise: planTotal(plan) };
}

const PLAN_SELECT = `SELECT p.*, c.name AS course_name FROM crm_fee_plans p
  LEFT JOIN crm_courses c ON c.id = p.course_id AND c.school_id = p.school_id`;

async function itemsFor(db, scope, planIds) {
  if (!planIds.length) return {};
  const result = await db.execute({
    sql: `SELECT * FROM crm_fee_plan_items WHERE school_id = ? AND plan_id IN (${planIds.map(() => '?').join(', ')}) ORDER BY plan_id, position`,
    args: [scope.schoolId, ...planIds],
  });
  const byPlan = {};
  for (const row of result.rows) (byPlan[row.plan_id] ||= []).push(row);
  return byPlan;
}

export async function loadPlan(db, scope, planId) {
  const result = await db.execute({ sql: `${PLAN_SELECT} WHERE p.id = ? AND p.school_id = ?`, args: [planId, scope.schoolId] });
  const row = result.rows[0];
  if (!row) throw crmErrors.notFound();
  return serializePlan(row, (await itemsFor(db, scope, [row.id]))[row.id] || []);
}

export async function listPlans({ db, scope, input }) {
  const { status, courseId } = input.query;
  const clauses = ['p.school_id = ?'];
  const args = [scope.schoolId];
  if (status !== 'all') { clauses.push('p.status = ?'); args.push(status); }
  if (courseId) { clauses.push('p.course_id = ?'); args.push(courseId); }
  const result = await db.execute({ sql: `${PLAN_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY p.status = 'active' DESC, p.name COLLATE NOCASE`, args });
  const items = await itemsFor(db, scope, result.rows.map((row) => row.id));
  return { items: result.rows.map((row) => serializePlan(row, items[row.id] || [])), nextCursor: null };
}

async function assertCourse(db, scope, courseId, current = null) {
  if (!courseId) return;
  const found = await db.execute({ sql: 'SELECT status FROM crm_courses WHERE id = ? AND school_id = ?', args: [courseId, scope.schoolId] });
  if (!found.rows[0] || (found.rows[0].status !== 'active' && courseId !== current)) {
    throw crmErrors.validation([{ path: 'courseId', message: 'Choose one of the school\'s active courses' }]);
  }
}

function planValues(body) {
  const monthly = body.kind === 'monthly' ? body.monthly : null;
  return [body.name, nameKey(body.name), body.courseId || null, body.kind, monthly?.amountPaise ?? null, monthly?.count ?? null, monthly?.dueDay ?? null, body.description || null];
}

function itemInserts(scope, planId, items, now) {
  return items.map((item, position) => ({
    sql: `INSERT INTO crm_fee_plan_items (id, school_id, plan_id, position, label, amount_paise, due_offset_value, due_offset_unit, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [newId('fpi'), scope.schoolId, planId, position, item.label, item.amountPaise, item.dueOffsetValue, item.dueOffsetUnit, now, now],
  }));
}

export async function createPlan({ db, scope, input }) {
  const body = input.body;
  await assertCourse(db, scope, body.courseId);
  const planId = newId('fplan');
  const now = new Date().toISOString();
  try {
    await db.batch([
      {
        sql: `INSERT INTO crm_fee_plans (id, school_id, name, name_key, course_id, kind, monthly_amount_paise, monthly_count, monthly_due_day, description, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [planId, scope.schoolId, ...planValues(body), scope.actor.user_id || null, now, now],
      },
      ...itemInserts(scope, planId, body.items, now),
      auditStatement(scope, { action: 'fee_plan.changed', entityId: planId, summary: { change: 'created', name: body.name }, now }),
    ], 'write');
  } catch (error) {
    throw duplicateName(error, PLAN_NAME_TAKEN);
  }
  return loadPlan(db, scope, planId);
}

/** Replaces the plan's details and charges. Invoices already made keep their copied amounts. */
export async function updatePlan({ db, scope, input }) {
  const body = input.body;
  const current = await loadPlan(db, scope, body.planId);
  await assertCourse(db, scope, body.courseId, current.course?.id || null);
  const now = new Date().toISOString();
  const guard = { sql: 'EXISTS (SELECT 1 FROM crm_fee_plans WHERE id = ? AND version = ? AND updated_at = ?)', args: [current.id, body.expectedVersion + 1, now] };
  let results;
  try {
    results = await db.batch([
      {
        sql: `UPDATE crm_fee_plans SET name = ?, name_key = ?, course_id = ?, kind = ?, monthly_amount_paise = ?, monthly_count = ?, monthly_due_day = ?, description = ?,
                     version = version + 1, updated_at = ?
              WHERE id = ? AND school_id = ? AND version = ?`,
        args: [...planValues(body), now, current.id, scope.schoolId, body.expectedVersion],
      },
      { sql: `DELETE FROM crm_fee_plan_items WHERE school_id = ? AND plan_id = ? AND ${guard.sql}`, args: [scope.schoolId, current.id, ...guard.args] },
      ...itemInserts(scope, current.id, body.items, now).map((statement) => ({
        sql: statement.sql.replace('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`),
        args: [...statement.args, ...guard.args],
      })),
      auditStatement(scope, { action: 'fee_plan.changed', entityId: current.id, summary: { change: 'updated', name: body.name }, when: guard, now }),
    ], 'write');
  } catch (error) {
    throw duplicateName(error, PLAN_NAME_TAKEN);
  }
  await assertVersionedWrite(results, 0, async () => (await loadPlan(db, scope, current.id)).version);
  return loadPlan(db, scope, current.id);
}

function statusHandler(to, change) {
  return async ({ db, scope, input }) => {
    const plan = await loadPlan(db, scope, input.body.planId);
    if (plan.status === to) throw new CrmHttpError(422, 'invalid_transition', to === 'archived' ? 'This plan is already archived' : 'This plan is already active');
    const now = new Date().toISOString();
    const results = await db.batch([
      { sql: 'UPDATE crm_fee_plans SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND school_id = ? AND version = ?', args: [to, now, plan.id, scope.schoolId, input.body.expectedVersion] },
      auditStatement(scope, { action: 'fee_plan.changed', entityId: plan.id, summary: { change, name: plan.name }, onlyIfChanged: true, now }),
    ], 'write');
    await assertVersionedWrite(results, 0, async () => (await loadPlan(db, scope, plan.id)).version);
    return loadPlan(db, scope, plan.id);
  };
}

// Archived plans can't be applied to new students; their invoices are untouched.
export const archivePlan = statusHandler('archived', 'archived');
export const restorePlan = statusHandler('active', 'restored');

// ---------------------------------------------------------------- settings --

function initials(name) {
  const letters = String(name || '').split(/\s+/).filter(Boolean).map((word) => word[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (letters.length >= 2 ? letters : `${letters}FEE`).slice(0, 8);
}

function serializeSettings(row) {
  return {
    prefix: row.prefix,
    headerName: row.header_name,
    headerAddress: row.header_address || '',
    headerPhone: row.header_phone || '',
    headerGstin: row.header_gstin || '',
    footerNote: row.footer_note || '',
    version: Number(row.version || 0),
  };
}

/** Saved settings, or defaults (version 0) from the school and its Skyll billing profile. */
export async function feeSettings(db, scope) {
  const saved = await db.execute({ sql: 'SELECT * FROM crm_fee_settings WHERE school_id = ?', args: [scope.schoolId] });
  if (saved.rows[0]) return { ...serializeSettings(saved.rows[0]), saved: true };
  const [school, profile] = await Promise.all([
    db.execute({ sql: 'SELECT display_name FROM schools WHERE id = ?', args: [scope.schoolId] }),
    db.execute({ sql: "SELECT legal_name, address, gstin FROM school_billing_profiles WHERE school_id = ?", args: [scope.schoolId] }).catch(() => ({ rows: [] })),
  ]);
  const name = school.rows[0]?.display_name || scope.schoolName || 'School';
  const billing = profile.rows[0];
  return {
    prefix: initials(name),
    headerName: billing?.legal_name || name,
    headerAddress: billing?.address || '',
    headerPhone: '',
    headerGstin: billing?.gstin || '',
    footerNote: '',
    version: 0,
    saved: false,
  };
}

export async function getFeeSettings({ db, scope }) {
  return feeSettings(db, scope);
}

const SETTING_FIELDS = [['prefix', 'prefix'], ['headerName', 'header_name'], ['headerAddress', 'header_address'], ['headerPhone', 'header_phone'], ['headerGstin', 'header_gstin'], ['footerNote', 'footer_note']];

export async function saveFeeSettings({ db, scope, input }) {
  const body = input.body;
  const current = await feeSettings(db, scope);
  if (current.version !== body.expectedVersion) throw versionConflict(current.version);
  const values = SETTING_FIELDS.map(([key]) => (body[key] === undefined || body[key] === '' ? null : body[key]));
  const fields = SETTING_FIELDS.filter(([key]) => String(current[key] ?? '') !== String(body[key] ?? '')).map(([key]) => key);
  const now = new Date().toISOString();
  const write = body.expectedVersion === 0
    ? {
      sql: `INSERT INTO crm_fee_settings (school_id, prefix, header_name, header_address, header_phone, header_gstin, footer_note, updated_by, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM crm_fee_settings WHERE school_id = ?)`,
      args: [scope.schoolId, ...values, scope.actor.user_id || null, now, now, scope.schoolId],
    }
    : {
      sql: `UPDATE crm_fee_settings SET prefix = ?, header_name = ?, header_address = ?, header_phone = ?, header_gstin = ?, footer_note = ?,
                   updated_by = ?, version = version + 1, updated_at = ?
            WHERE school_id = ? AND version = ?`,
      args: [...values, scope.actor.user_id || null, now, scope.schoolId, body.expectedVersion],
    };
  const results = await db.batch([
    write,
    auditStatement(scope, { action: 'fee_settings.changed', entityId: scope.schoolId, summary: { fields: fields.length ? fields : ['prefix'], prefix: body.prefix }, onlyIfChanged: true, now }),
  ], 'write');
  if (!Number(results[0].rowsAffected)) throw versionConflict((await feeSettings(db, scope)).version);
  return feeSettings(db, scope);
}
