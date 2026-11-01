// Follow-up tasks (CRM-012, FLKRM-326 S2). Every change writes an append-only
// crm_task_events row and a `task.changed` audit event in the same batch.
//
// Visibility (D11): admins and task-grant holders see and assign every task in
// the school. Roles limited to their own records (teachers by default) see,
// create and change only tasks assigned to them, and never reassign.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertTransition } from '../../shared/crm/lifecycles.js';
import { createTaskBody, dueAtField } from '../../shared/crm/tasks.js';
import { dayBounds } from '../../shared/crm/time.js';
import { auditStatement } from './audit.js';
import { assertVersionedWrite, expectedVersion } from './concurrency.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { assertAssignable, membersWith } from './members.js';
import { decodeCursor, listQuery, toPage } from './pagination.js';
import { can, ownRecordsOnly } from './permissions.js';
import { assertRecord } from './records.js';

const FOLLOW_UP_DELAY_MS = 24 * 60 * 60 * 1000;

const taskId = z.string().min(1).max(128);
const userId = z.string().trim().min(1).max(128);

export { createTaskBody };

export const listTasksQuery = listQuery.extend({
  view: z.enum(['mine', 'all']).default('mine'),
  status: z.enum(['open', 'done', 'cancelled']).default('open'),
  relatedType: z.enum(['lead', 'student']).optional(),
  relatedId: z.string().max(128).optional(),
}).refine((query) => Boolean(query.relatedType) === Boolean(query.relatedId), {
  message: 'Send relatedType and relatedId together',
});

export const taskStatusBody = z.object({ taskId, expectedVersion }).strict();
export const rescheduleTaskBody = z.object({ taskId, dueAt: dueAtField, expectedVersion }).strict();
export const reassignTaskBody = z.object({ taskId, ownerUserId: userId.nullable(), expectedVersion }).strict();

const TASK_SELECT = `
  SELECT t.id, t.title, t.details, t.owner_user_id, t.due_at, t.priority, t.related_type, t.related_id,
         t.status, t.completed_at, t.version, t.created_at, t.updated_at,
         ou.display_name AS owner_name,
         EXISTS (SELECT 1 FROM school_memberships om
                 WHERE om.user_id = t.owner_user_id AND om.school_id = t.school_id AND om.status = 'active') AS owner_active,
         rl.learner_name AS lead_name, rs.display_name AS student_name
  FROM crm_tasks t
  LEFT JOIN users ou ON ou.id = t.owner_user_id
  LEFT JOIN crm_leads rl ON t.related_type = 'lead' AND rl.id = t.related_id AND rl.school_id = t.school_id AND rl.anonymised_at IS NULL
  LEFT JOIN students rs ON t.related_type = 'student' AND rs.id = t.related_id AND rs.school_id = t.school_id`;

/** Whether this actor sees the whole school's tasks or only their own. */
export function taskScope(scope) {
  return ownRecordsOnly(scope, 'crm.tasks.read') ? 'own' : 'school';
}

// A related record's name shows only to people who may read that record type;
// phones never appear on tasks.
function serializeRelated(row, scope) {
  if (!row.related_type) return null;
  const capability = row.related_type === 'lead' ? 'crm.leads.read' : 'crm.students.read';
  const visible = can(scope, capability);
  const name = row.related_type === 'lead' ? row.lead_name : row.student_name;
  return { type: row.related_type, id: row.related_id, name: visible ? name || null : null, restricted: !visible };
}

function serializeTask(row, scope) {
  const ownerActive = Boolean(row.owner_user_id) && Number(row.owner_active) === 1;
  return {
    id: row.id,
    title: row.title,
    details: row.details || null,
    dueAt: row.due_at,
    priority: row.priority,
    status: row.status,
    ownerUserId: row.owner_user_id || null,
    // A disabled owner shows as unassigned until someone reassigns the task.
    owner: ownerActive ? { userId: row.owner_user_id, name: row.owner_name || null } : null,
    related: serializeRelated(row, scope),
    completedAt: row.completed_at || null,
    version: Number(row.version),
    createdAt: row.created_at,
  };
}

async function loadTaskRow(db, scope, id) {
  const result = await db.execute({ sql: `${TASK_SELECT} WHERE t.id = ? AND t.school_id = ?`, args: [id, scope.schoolId] });
  const row = result.rows[0];
  // Other people's tasks are invisible to own-records-only roles: 404, not 403.
  if (!row || (taskScope(scope) === 'own' && row.owner_user_id !== scope.actor.user_id)) throw crmErrors.notFound();
  return row;
}

async function loadTask(db, scope, id) {
  return serializeTask(await loadTaskRow(db, scope, id), scope);
}

async function assertRelatedVisible(db, scope, target) {
  await assertRecord(db, scope, target.type, target.id, 'read');
}

function eventStatement(scope, { taskId: id, type, from = null, to = null, now, onlyIfChanged = false }) {
  const values = [`tev_${randomUUID()}`, scope.schoolId, id, type, from, to, scope.actor.user_id || null, now];
  const columns = '(id, school_id, task_id, event_type, from_value, to_value, actor_user_id, created_at)';
  return onlyIfChanged
    ? { sql: `INSERT INTO crm_task_events ${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`, args: values }
    : { sql: `INSERT INTO crm_task_events ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: values };
}

/**
 * Statements that create a task, its `created` event and its audit event.
 * Used by `POST tasks` and by lead creation (the owner's follow-up task).
 */
export function taskCreateStatements(scope, { title, details = null, dueAt, priority = 'normal', ownerUserId, related: target = null, auto = false, now }) {
  const id = `task_${randomUUID()}`;
  return {
    id,
    statements: [
      {
        sql: `INSERT INTO crm_tasks (id, school_id, title, details, owner_user_id, due_at, priority, related_type, related_id,
                                     created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, scope.schoolId, title, details, ownerUserId, dueAt, priority, target?.type || null, target?.id || null,
          scope.actor.user_id || null, now, now],
      },
      eventStatement(scope, { taskId: id, type: 'created', to: ownerUserId, now }),
      auditStatement(scope, {
        action: 'task.changed',
        entityId: id,
        summary: {
          change: 'created', ownerUserId,
          ...(target ? { relatedType: target.type, relatedId: target.id } : {}),
          ...(auto ? { auto: true } : {}),
        },
        now,
      }),
    ],
  };
}

/** The automatic "Follow up with …" task for a new lead's owner (D12). */
export function followUpTaskStatements(scope, { leadId, learnerName, ownerUserId, now }) {
  return taskCreateStatements(scope, {
    title: `Follow up with ${learnerName}`.slice(0, 160),
    dueAt: new Date(Date.parse(now) + FOLLOW_UP_DELAY_MS).toISOString(),
    ownerUserId,
    related: { type: 'lead', id: leadId },
    auto: true,
    now,
  }).statements;
}

export async function createTask({ db, scope, input }) {
  const body = input.body;
  const own = ownRecordsOnly(scope, 'crm.tasks.write');
  let ownerUserId = body.ownerUserId === undefined ? (scope.support ? null : scope.actor.user_id) : body.ownerUserId;
  if (own && ownerUserId !== scope.actor.user_id) {
    throw new CrmHttpError(403, 'forbidden', 'You can only create tasks for yourself');
  }
  if (ownerUserId && !own) await assertAssignable(db, scope.schoolId, ownerUserId, 'crm.tasks.write');
  if (body.related) await assertRelatedVisible(db, scope, body.related);
  ownerUserId = ownerUserId || null;

  const now = new Date().toISOString();
  const { id, statements } = taskCreateStatements(scope, {
    title: body.title, details: body.details || null, dueAt: body.dueAt, priority: body.priority, ownerUserId, related: body.related, now,
  });
  await db.batch(statements, 'write');
  return loadTask(db, scope, id);
}

export async function listTasks({ db, scope, input }) {
  const { limit, cursor, view, status, relatedType, relatedId } = input.query;
  const after = decodeCursor(cursor, 2);
  const clauses = ['t.school_id = ?', 't.status = ?'];
  const args = [scope.schoolId, status];
  // Own-records-only roles always get their own tasks, whatever view they ask for.
  const effectiveView = taskScope(scope) === 'own' ? 'mine' : view;
  if (effectiveView === 'mine') { clauses.push('t.owner_user_id = ?'); args.push(scope.actor.user_id || ''); }
  if (relatedType) {
    if (!can(scope, relatedType === 'lead' ? 'crm.leads.read' : 'crm.students.read')) throw crmErrors.forbidden();
    clauses.push('t.related_type = ? AND t.related_id = ?');
    args.push(relatedType, relatedId);
  }
  if (after) { clauses.push('(t.due_at > ? OR (t.due_at = ? AND t.id > ?))'); args.push(after[0], after[0], after[1]); }
  const result = await db.execute({
    sql: `${TASK_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY t.due_at ASC, t.id ASC LIMIT ?`,
    args: [...args, limit + 1],
  });
  const page = toPage(result.rows, limit, (row) => [row.due_at, row.id], (row) => serializeTask(row, scope));
  return { ...page, view: effectiveView };
}

/** Counts for the nav badge and dashboard: mine always, the whole school when allowed. */
export async function taskSummary({ db, scope }) {
  const now = Date.now();
  const { end } = dayBounds(now, scope.timezone);
  const nowIso = new Date(now).toISOString();
  const endIso = new Date(end).toISOString();
  const counts = `SUM(CASE WHEN t.due_at < ? THEN 1 ELSE 0 END) AS overdue,
                  SUM(CASE WHEN t.due_at >= ? AND t.due_at < ? THEN 1 ELSE 0 END) AS today,
                  SUM(CASE WHEN t.due_at >= ? THEN 1 ELSE 0 END) AS upcoming`;
  const bucketArgs = [nowIso, nowIso, endIso, endIso];
  const shape = (row = {}) => ({ overdue: Number(row.overdue || 0), today: Number(row.today || 0), upcoming: Number(row.upcoming || 0) });

  const mine = await db.execute({
    sql: `SELECT ${counts} FROM crm_tasks t WHERE t.school_id = ? AND t.status = 'open' AND t.owner_user_id = ?`,
    args: [...bucketArgs, scope.schoolId, scope.actor.user_id || ''],
  });
  const result = { timezone: scope.timezone, scope: taskScope(scope), mine: shape(mine.rows[0]) };
  if (result.scope === 'school') {
    const all = await db.execute({
      sql: `SELECT ${counts},
                   SUM(CASE WHEN t.owner_user_id IS NULL OR NOT EXISTS (
                         SELECT 1 FROM school_memberships om WHERE om.user_id = t.owner_user_id AND om.school_id = t.school_id AND om.status = 'active'
                       ) THEN 1 ELSE 0 END) AS unassigned
            FROM crm_tasks t WHERE t.school_id = ? AND t.status = 'open'`,
      args: [...bucketArgs, scope.schoolId],
    });
    result.all = { ...shape(all.rows[0]), unassigned: Number(all.rows[0]?.unassigned || 0) };
  }
  return result;
}

export async function listTaskAssignees({ db, scope }) {
  if (ownRecordsOnly(scope, 'crm.tasks.write')) {
    return { items: [{ userId: scope.actor.user_id, name: null, role: scope.actor.role }], nextCursor: null };
  }
  return { items: await membersWith(db, scope.schoolId, 'crm.tasks.write'), nextCursor: null };
}

async function changeTask(db, scope, row, { set, args, event, audit, version }) {
  const now = new Date().toISOString();
  const results = await db.batch([
    {
      sql: `UPDATE crm_tasks SET ${set}, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND version = ?`,
      args: [...args, now, row.id, scope.schoolId, version],
    },
    eventStatement(scope, { taskId: row.id, ...event, now, onlyIfChanged: true }),
    auditStatement(scope, {
      action: 'task.changed',
      entityId: row.id,
      summary: { ...audit, ...(row.related_type ? { relatedType: row.related_type, relatedId: row.related_id } : {}) },
      onlyIfChanged: true,
      now,
    }),
  ], 'write');
  await assertVersionedWrite(results, 0, async () => {
    const current = await db.execute({ sql: 'SELECT version FROM crm_tasks WHERE id = ? AND school_id = ?', args: [row.id, scope.schoolId] });
    return current.rows[0]?.version ?? null;
  });
  return loadTask(db, scope, row.id);
}

function statusHandler(to, change) {
  return async ({ db, scope, input }) => {
    const row = await loadTaskRow(db, scope, input.body.taskId);
    assertTransition('task', row.status, to);
    const now = new Date().toISOString();
    const done = to === 'done';
    return changeTask(db, scope, row, {
      set: 'status = ?, completed_at = ?, completed_by = ?',
      args: [to, done ? now : null, done ? scope.actor.user_id || null : null],
      event: { type: change, from: row.status, to },
      audit: { change },
      version: input.body.expectedVersion,
    });
  };
}

export const completeTask = statusHandler('done', 'completed');
export const reopenTask = statusHandler('open', 'reopened');
export const cancelTask = statusHandler('cancelled', 'cancelled');

export async function rescheduleTask({ db, scope, input }) {
  const { taskId: id, dueAt, expectedVersion: version } = input.body;
  const row = await loadTaskRow(db, scope, id);
  if (row.status !== 'open') throw new CrmHttpError(422, 'invalid_transition', 'Only open tasks can be rescheduled');
  if (row.due_at === dueAt) throw crmErrors.validation([{ path: 'dueAt', message: 'Choose a different time' }]);
  return changeTask(db, scope, row, {
    set: 'due_at = ?',
    args: [dueAt],
    event: { type: 'rescheduled', from: row.due_at, to: dueAt },
    audit: { change: 'rescheduled', fromDueAt: row.due_at, toDueAt: dueAt },
    version,
  });
}

export async function reassignTask({ db, scope, input }) {
  if (ownRecordsOnly(scope, 'crm.tasks.write')) throw crmErrors.forbidden();
  const { taskId: id, ownerUserId, expectedVersion: version } = input.body;
  const row = await loadTaskRow(db, scope, id);
  if (row.status !== 'open') throw new CrmHttpError(422, 'invalid_transition', 'Only open tasks can be reassigned');
  if ((row.owner_user_id || null) === ownerUserId) throw crmErrors.validation([{ path: 'ownerUserId', message: 'This person already owns the task' }]);
  if (ownerUserId) await assertAssignable(db, scope.schoolId, ownerUserId, 'crm.tasks.write');
  return changeTask(db, scope, row, {
    set: 'owner_user_id = ?',
    args: [ownerUserId],
    event: { type: 'reassigned', from: row.owner_user_id || null, to: ownerUserId },
    audit: { change: 'reassigned', fromOwnerUserId: row.owner_user_id || null, toOwnerUserId: ownerUserId },
    version,
  });
}

/**
 * Statements that move a lead's open tasks from its previous owner to the new
 * one. Each UPDATE is guarded so it only applies if the lead's owner change in
 * the same batch succeeded (the lead now has `toOwner` at `leadVersion + 1`).
 */
export async function moveLeadTasksStatements(db, scope, { leadId, fromOwner, toOwner, leadVersion, now }) {
  const open = await db.execute({
    sql: `SELECT id FROM crm_tasks
          WHERE school_id = ? AND related_type = 'lead' AND related_id = ? AND status = 'open' AND owner_user_id IS ?`,
    args: [scope.schoolId, leadId, fromOwner],
  });
  const statements = [];
  for (const task of open.rows) {
    statements.push(
      {
        sql: `UPDATE crm_tasks SET owner_user_id = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND school_id = ? AND status = 'open' AND owner_user_id IS ?
                AND EXISTS (SELECT 1 FROM crm_leads WHERE id = ? AND school_id = ? AND owner_user_id = ? AND version = ?)`,
        args: [toOwner, now, task.id, scope.schoolId, fromOwner, leadId, scope.schoolId, toOwner, leadVersion + 1],
      },
      eventStatement(scope, { taskId: task.id, type: 'reassigned', from: fromOwner, to: toOwner, now, onlyIfChanged: true }),
      auditStatement(scope, {
        action: 'task.changed',
        entityId: task.id,
        summary: { change: 'reassigned', fromOwnerUserId: fromOwner, toOwnerUserId: toOwner, relatedType: 'lead', relatedId: leadId },
        onlyIfChanged: true,
        now,
      }),
    );
  }
  return { count: open.rows.length, statements };
}
