// Leads API (CRM-007/009/010, FLKRM-326). New leads enter the first open stage,
// `lost` needs a reason key, and `won` is unreachable by moving stages — only
// conversion (CRM-011) may get there. Creating a lead checks for likely
// duplicates and warns; it never merges records.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  LEAD_SOURCE_KEYS, LOST_REASON_KEYS, createLeadBody, leadInterest, lostReasonLabel, normalizePersonName,
} from '../../shared/crm/leads.js';
import { assertTransition, derivePersonLifecycle } from '../../shared/crm/lifecycles.js';
import { DEFAULT_LEAD_SOURCES } from '../../shared/crm/pipeline.js';
import { normalizePhone } from '../../api/_lib/phone.js';
import { auditStatement } from './audit.js';
import { assertVersionedWrite, expectedVersion } from './concurrency.js';
import { contactStatements } from './contacts.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { assertAssignable, membersWith } from './members.js';
import { decodeCursor, listQuery, toPage } from './pagination.js';
import { can, ownRecordsOnly } from './permissions.js';
import { ensureDefaultPipeline } from './pipeline.js';
import { tagsFor } from './tags.js';
import { followUpTaskStatements, moveLeadTasksStatements } from './tasks.js';

const leadId = z.string().min(1).max(128);
const userId = z.string().trim().min(1).max(128);

export { createLeadBody };

export const listLeadsQuery = listQuery.extend({
  stageId: z.string().max(160).optional(),
  ownerUserId: z.string().max(128).optional(),
  q: z.string().trim().max(120).optional(),
});

export const leadQuery = z.object({ leadId }).strict();

export const duplicatesQuery = z.object({
  phone: z.string().trim().max(24).optional(),
  learnerName: z.string().trim().max(120).optional(),
}).strict();

export const moveLeadBody = z.object({
  leadId,
  toStageId: z.string().min(1).max(160),
  lostReasonKey: z.enum(LOST_REASON_KEYS).optional(),
  // Optional note; required when the lost reason is `other`.
  reason: z.string().trim().max(280).optional(),
  expectedVersion,
}).strict();

export const setOwnerBody = z.object({
  leadId,
  ownerUserId: userId,
  expectedVersion,
  // Also hand the lead's open tasks from the previous owner to the new one (D12).
  moveOpenTasks: z.boolean().optional(),
}).strict();

export const updateLeadBody = z.object({
  leadId,
  expectedVersion,
  learnerName: z.string().trim().min(1).max(120).optional(),
  learnerGrade: z.string().trim().max(32).nullable().optional(),
  sourceKey: z.enum(LEAD_SOURCE_KEYS).nullable().optional(),
  interest: leadInterest.optional(),
}).strict();

/** Default sources, created once per school with deterministic ids. */
export async function ensureLeadSources(db, schoolId, now = new Date().toISOString()) {
  await db.batch(DEFAULT_LEAD_SOURCES.map((source) => ({
    sql: `INSERT OR IGNORE INTO crm_lead_sources (id, school_id, source_key, label, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [`src_${schoolId}_${source.key}`, schoolId, source.key, source.label, now, now],
  })), 'write');
}

// An owner counts only while they hold an active membership in the school;
// otherwise the lead shows as unowned until reassigned (§1.10).
const LEAD_SELECT = `
  SELECT l.id, l.learner_name, l.learner_grade, l.owner_user_id, l.lost_reason, l.lost_reason_key, l.lost_at,
         l.interest_json, l.converted_student_id, l.converted_at, l.version,
         l.created_at, l.last_activity_at, l.primary_contact_id,
         st.id AS stage_id, st.name AS stage_name, st.category AS stage_category,
         src.source_key, src.label AS source_label,
         c.full_name AS contact_name, c.phone_e164 AS contact_phone, c.whatsapp_opted_in AS contact_opted_in,
         ou.display_name AS owner_name,
         EXISTS (SELECT 1 FROM school_memberships om
                 WHERE om.user_id = l.owner_user_id AND om.school_id = l.school_id AND om.status = 'active') AS owner_active
  FROM crm_leads l
  JOIN crm_pipeline_stages st ON st.id = l.stage_id AND st.school_id = l.school_id
  LEFT JOIN crm_lead_sources src ON src.id = l.source_id AND src.school_id = l.school_id
  LEFT JOIN crm_contacts c ON c.id = l.primary_contact_id AND c.school_id = l.school_id AND c.anonymised_at IS NULL
  LEFT JOIN users ou ON ou.id = l.owner_user_id`;

function parseInterest(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return { course: parsed.course || null, schedule: parsed.schedule || null };
  } catch {
    return { course: null, schedule: null };
  }
}

function interestJson(value = {}) {
  const clean = {};
  if (value.course) clean.course = value.course;
  if (value.schedule) clean.schedule = value.schedule;
  return JSON.stringify(clean);
}

// Contact details are returned only with crm.contacts.read (CRM-002: contact
// data is separate from lead data).
function serializeLead(row, scope) {
  const showContact = can(scope, 'crm.contacts.read');
  const ownerActive = Boolean(row.owner_user_id) && Number(row.owner_active) === 1;
  return {
    id: row.id,
    learnerName: row.learner_name,
    learnerGrade: row.learner_grade || null,
    stage: { id: row.stage_id, name: row.stage_name, category: row.stage_category },
    // A converted lead's person now lives on the student record (CRM_CONTRACTS §1.1).
    lifecycle: row.converted_student_id ? 'converted' : derivePersonLifecycle({ stageCategory: row.stage_category }),
    source: row.source_key ? { key: row.source_key, label: row.source_label } : null,
    interest: parseInterest(row.interest_json),
    ownerUserId: row.owner_user_id || null,
    owner: ownerActive ? { userId: row.owner_user_id, name: row.owner_name || null } : null,
    lostReasonKey: row.lost_reason_key || null,
    lostReason: row.lost_reason || null,
    convertedStudentId: row.converted_student_id || null,
    hasContact: Boolean(row.primary_contact_id),
    contact: showContact && row.primary_contact_id
      ? {
        id: row.primary_contact_id,
        name: row.contact_name || null,
        phone: row.contact_phone || null,
        whatsappOptIn: Number(row.contact_opted_in) === 1,
      }
      : null,
    version: Number(row.version),
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

async function loadLead(db, scope, id) {
  const result = await db.execute({
    sql: `${LEAD_SELECT} WHERE l.id = ? AND l.school_id = ? AND l.archived_at IS NULL`,
    args: [id, scope.schoolId],
  });
  if (!result.rows[0]) throw crmErrors.notFound();
  const tags = await tagsFor(db, scope, 'lead', [id]);
  return { ...serializeLead(result.rows[0], scope), tags: tags[id] || [] };
}

async function currentVersion(db, scope, id) {
  const row = await db.execute({ sql: 'SELECT version FROM crm_leads WHERE id = ? AND school_id = ? AND archived_at IS NULL', args: [id, scope.schoolId] });
  return row.rows[0]?.version ?? null;
}

/**
 * Likely duplicates the caller is allowed to see (D10). Phone matches need
 * `crm.contacts.read`, student matches need `crm.students.read`, so the check
 * never reveals data the caller couldn't read directly. Phones are never
 * returned; each match carries only the reason it matched.
 */
export async function findDuplicates(db, scope, { phone, learnerName }) {
  const matches = new Map();
  const add = (key, match, reason) => {
    const existing = matches.get(key);
    if (existing) { if (!existing.reasons.includes(reason)) existing.reasons.push(reason); return; }
    matches.set(key, { ...match, reasons: [reason] });
  };
  const phoneE164 = can(scope, 'crm.contacts.read') ? normalizePhone(phone) : null;
  const name = normalizePersonName(learnerName);
  const seeStudents = can(scope, 'crm.students.read');

  const leadMatch = (row) => ({
    kind: 'lead',
    id: row.id,
    name: row.learner_name,
    stage: { name: row.stage_name, category: row.stage_category },
    ownerName: row.owner_name || null,
    convertedStudentId: row.converted_student_id || null,
  });
  const studentMatch = (row) => ({ kind: 'student', id: row.id, name: row.display_name, status: row.status });

  const leadSelect = `SELECT l.id, l.learner_name, l.converted_student_id, st.name AS stage_name, st.category AS stage_category,
                             ou.display_name AS owner_name
                      FROM crm_leads l
                      JOIN crm_pipeline_stages st ON st.id = l.stage_id
                      LEFT JOIN users ou ON ou.id = l.owner_user_id`;

  if (phoneE164) {
    const leads = await db.execute({
      sql: `${leadSelect}
            JOIN crm_contacts c ON c.id = l.primary_contact_id AND c.school_id = l.school_id
            WHERE l.school_id = ? AND l.archived_at IS NULL AND l.anonymised_at IS NULL AND c.phone_e164 = ? AND c.anonymised_at IS NULL
            ORDER BY l.created_at DESC LIMIT 20`,
      args: [scope.schoolId, phoneE164],
    });
    for (const row of leads.rows) add(`lead:${row.id}`, leadMatch(row), 'phone');
    if (seeStudents) {
      const students = await db.execute({
        sql: `SELECT DISTINCT s.id, s.display_name, s.status
              FROM crm_guardian_links g
              JOIN crm_contacts c ON c.id = g.contact_id AND c.school_id = g.school_id
              JOIN students s ON s.id = g.student_id AND s.school_id = g.school_id
              WHERE g.school_id = ? AND g.status = 'active' AND c.phone_e164 = ? AND c.anonymised_at IS NULL
                AND s.status != 'archived'
              LIMIT 20`,
        args: [scope.schoolId, phoneE164],
      });
      for (const row of students.rows) add(`student:${row.id}`, studentMatch(row), 'phone');
    }
  }

  // Exact normalised-name equality only; similar names never match (§1.3).
  if (name) {
    const leads = await db.execute({
      sql: `${leadSelect} WHERE l.school_id = ? AND l.archived_at IS NULL AND l.anonymised_at IS NULL`,
      args: [scope.schoolId],
    });
    for (const row of leads.rows) {
      if (normalizePersonName(row.learner_name) === name) add(`lead:${row.id}`, leadMatch(row), 'name');
    }
    if (seeStudents) {
      const students = await db.execute({
        sql: "SELECT id, display_name, status FROM students WHERE school_id = ? AND status != 'archived'",
        args: [scope.schoolId],
      });
      for (const row of students.rows) {
        if (normalizePersonName(row.display_name) === name) add(`student:${row.id}`, studentMatch(row), 'name');
      }
    }
  }
  return [...matches.values()];
}

export async function checkDuplicates({ db, scope, input }) {
  return { matches: await findDuplicates(db, scope, input.query) };
}

async function firstOpenStage(db, scope, pipelineId) {
  const result = await db.execute({
    sql: `SELECT id FROM crm_pipeline_stages
          WHERE pipeline_id = ? AND school_id = ? AND category = 'open' AND archived_at IS NULL
          ORDER BY position LIMIT 1`,
    args: [pipelineId, scope.schoolId],
  });
  const stageId = result.rows[0]?.id;
  if (!stageId) throw new CrmHttpError(409, 'pipeline_misconfigured', 'The pipeline has no open stage for new leads');
  return stageId;
}

export async function createLead({ db, scope, input }) {
  const body = input.body;
  // Recording someone's phone number is a contact-data write.
  if (body.contact && !can(scope, 'crm.contacts.write')) throw crmErrors.forbidden();
  if (body.ownerUserId) await assertAssignable(db, scope.schoolId, body.ownerUserId, 'crm.leads.write');

  const matches = await findDuplicates(db, scope, { phone: body.contact?.phone, learnerName: body.learnerName });
  if (matches.length && !body.acknowledgeDuplicates) {
    throw new CrmHttpError(409, 'duplicate_warning', 'This family may already be in the CRM', { matches });
  }

  const now = new Date().toISOString();
  const pipelineId = await ensureDefaultPipeline(db, scope.schoolId, now);
  await ensureLeadSources(db, scope.schoolId, now);
  const stageId = await firstOpenStage(db, scope, pipelineId);

  const statements = [];
  let contactId = null;
  if (body.contact) {
    const contact = await contactStatements(db, {
      schoolId: scope.schoolId,
      name: body.contact.name || null,
      phone: body.contact.phone,
      optedIn: body.contact.whatsappOptIn === true,
      actorUserId: scope.actor.user_id,
      now,
    });
    if (!contact) throw crmErrors.validation([{ path: 'contact.phone', message: 'Enter a valid phone number' }]);
    contactId = contact.contactId;
    statements.push(...contact.statements);
  }

  // Platform support staff aren't school members, so their leads start unowned.
  const ownerUserId = body.ownerUserId || (scope.support ? null : scope.actor.user_id || null);
  const id = `lead_${randomUUID()}`;
  statements.push(
    {
      sql: `INSERT INTO crm_leads (id, school_id, pipeline_id, stage_id, primary_contact_id, learner_name, learner_grade,
                                   interest_json, source_id, owner_user_id, last_activity_at, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, scope.schoolId, pipelineId, stageId, contactId, body.learnerName, body.learnerGrade || null,
        interestJson(body.interest), body.sourceKey ? `src_${scope.schoolId}_${body.sourceKey}` : null,
        ownerUserId, now, scope.actor.user_id || null, now, now,
      ],
    },
    {
      sql: `INSERT INTO crm_lead_stage_events (id, school_id, lead_id, from_stage_id, to_stage_id, actor_user_id, reason, created_at)
            VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)`,
      args: [`lse_${randomUUID()}`, scope.schoolId, id, stageId, scope.actor.user_id || null, now],
    },
    auditStatement(scope, {
      action: 'lead.created',
      entityId: id,
      summary: { stageId, channel: 'manual', ...(body.sourceKey ? { sourceKey: body.sourceKey } : {}), duplicateOverride: matches.length > 0 },
      now,
    }),
  );
  if (body.note) {
    statements.push({
      sql: `INSERT INTO crm_notes (id, school_id, entity_type, entity_id, body, author_user_id, created_at, updated_at)
            VALUES (?, ?, 'lead', ?, ?, ?, ?, ?)`,
      args: [`note_${randomUUID()}`, scope.schoolId, id, body.note, scope.actor.user_id || null, now, now],
    });
  }
  // Every new lead gets a follow-up task for its owner, due in 24 hours (D12).
  statements.push(...followUpTaskStatements(scope, { leadId: id, learnerName: body.learnerName, ownerUserId, now }));
  await db.batch(statements, 'write');
  return loadLead(db, scope, id);
}

export async function listLeads({ db, scope, input }) {
  const { limit, cursor, stageId, ownerUserId, q } = input.query;
  const after = decodeCursor(cursor, 2);
  const clauses = ['l.school_id = ?', 'l.archived_at IS NULL'];
  const args = [scope.schoolId];
  if (stageId) { clauses.push('l.stage_id = ?'); args.push(stageId); }
  if (ownerUserId) { clauses.push('l.owner_user_id = ?'); args.push(ownerUserId); }
  if (q) { clauses.push("l.learner_name LIKE ? ESCAPE '\\'"); args.push(`%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`); }
  if (after) { clauses.push('(l.created_at < ? OR (l.created_at = ? AND l.id < ?))'); args.push(after[0], after[0], after[1]); }
  const result = await db.execute({
    sql: `${LEAD_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
    args: [...args, limit + 1],
  });
  const page = toPage(result.rows, limit, (row) => [row.created_at, row.id], (row) => serializeLead(row, scope));
  const tags = await tagsFor(db, scope, 'lead', page.items.map((lead) => lead.id));
  return { ...page, items: page.items.map((lead) => ({ ...lead, tags: tags[lead.id] || [] })) };
}

/** One lead for its profile (CRM-007). History and notes come from `GET timeline` and `GET notes`. */
export async function getLead({ db, scope, input }) {
  const lead = await loadLead(db, scope, input.query.leadId);
  // How many open tasks would move with the lead if its owner changed.
  const ownerTasks = can(scope, 'crm.tasks.read')
    ? await db.execute({
      sql: `SELECT COUNT(*) AS n FROM crm_tasks
            WHERE school_id = ? AND related_type = 'lead' AND related_id = ? AND status = 'open' AND owner_user_id IS ?`,
      args: [scope.schoolId, lead.id, lead.ownerUserId],
    })
    : null;
  return { ...lead, ownerOpenTaskCount: ownerTasks ? Number(ownerTasks.rows[0].n) : null };
}

export async function listLeadOwners({ db, scope }) {
  return { items: await membersWith(db, scope.schoolId, 'crm.leads.write'), nextCursor: null };
}

export async function moveLeadStage({ db, scope, input }) {
  const { leadId: id, toStageId, lostReasonKey, reason, expectedVersion: version } = input.body;
  const current = await db.execute({
    sql: `SELECT l.pipeline_id, l.stage_id, st.category
          FROM crm_leads l JOIN crm_pipeline_stages st ON st.id = l.stage_id
          WHERE l.id = ? AND l.school_id = ? AND l.archived_at IS NULL`,
    args: [id, scope.schoolId],
  });
  const lead = current.rows[0];
  if (!lead) throw crmErrors.notFound();
  const target = await db.execute({
    sql: `SELECT id, category FROM crm_pipeline_stages
          WHERE id = ? AND school_id = ? AND pipeline_id = ? AND archived_at IS NULL`,
    args: [toStageId, scope.schoolId, lead.pipeline_id],
  });
  const to = target.rows[0];
  if (!to) throw crmErrors.notFound();
  if (to.id === lead.stage_id) throw crmErrors.validation([{ path: 'toStageId', message: 'The lead is already in this stage' }]);

  const becomesLost = to.category === 'lost';
  const note = reason || null;
  if (becomesLost && lostReasonKey === 'other' && !note) {
    throw crmErrors.validation([{ path: 'reason', message: 'Describe the reason when choosing Other' }]);
  }
  if (!becomesLost && lostReasonKey) {
    throw crmErrors.validation([{ path: 'lostReasonKey', message: 'Only a move to Lost takes a lost reason' }]);
  }
  // The stage event keeps a readable reason: the label, plus the note if any.
  const eventReason = becomesLost && lostReasonKey
    ? [lostReasonLabel(lostReasonKey), note].filter(Boolean).join(': ')
    : note;
  // Throws invalid_transition (e.g. any move to `won`) or reason_required
  // (a move to lost without a reason key).
  assertTransition('leadStage', lead.category, to.category, { reason: becomesLost ? (lostReasonKey && eventReason) : eventReason });

  const now = new Date().toISOString();
  const results = await db.batch([
    {
      sql: `UPDATE crm_leads
            SET stage_id = ?, version = version + 1, last_activity_at = ?, updated_at = ?,
                lost_reason = ?, lost_reason_key = ?, lost_at = ?
            WHERE id = ? AND school_id = ? AND version = ? AND archived_at IS NULL`,
      args: [to.id, now, now, becomesLost ? note : null, becomesLost ? lostReasonKey : null, becomesLost ? now : null, id, scope.schoolId, version],
    },
    {
      sql: `INSERT INTO crm_lead_stage_events (id, school_id, lead_id, from_stage_id, to_stage_id, actor_user_id, reason, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
      args: [`lse_${randomUUID()}`, scope.schoolId, id, lead.stage_id, to.id, scope.actor.user_id || null, eventReason || null, now],
    },
    auditStatement(scope, {
      action: 'lead.stage_changed',
      entityId: id,
      summary: {
        fromStageId: lead.stage_id, toStageId: to.id, fromCategory: lead.category, toCategory: to.category,
        ...(becomesLost ? { lostReasonKey } : {}),
        ...(note ? { reason: note } : {}),
      },
      onlyIfChanged: true,
      now,
    }),
  ], 'write');
  await assertVersionedWrite(results, 0, () => currentVersion(db, scope, id));
  return loadLead(db, scope, id);
}

export async function setLeadOwner({ db, scope, input }) {
  const { leadId: id, ownerUserId, expectedVersion: version, moveOpenTasks } = input.body;
  if (moveOpenTasks && (!can(scope, 'crm.tasks.write') || ownRecordsOnly(scope, 'crm.tasks.write'))) throw crmErrors.forbidden();
  const existing = await db.execute({
    sql: 'SELECT owner_user_id FROM crm_leads WHERE id = ? AND school_id = ? AND archived_at IS NULL',
    args: [id, scope.schoolId],
  });
  if (!existing.rows[0]) throw crmErrors.notFound();
  const from = existing.rows[0].owner_user_id || null;
  if (from === ownerUserId) throw crmErrors.validation([{ path: 'ownerUserId', message: 'This person already owns the lead' }]);
  const owner = await assertAssignable(db, scope.schoolId, ownerUserId, 'crm.leads.write');
  if (moveOpenTasks && !owner.capabilities.has('crm.tasks.write')) {
    throw new CrmHttpError(422, 'invalid_owner', `${owner.name || 'This person'} can't be given tasks`, [{ path: 'moveOpenTasks', message: 'The new owner has no task access' }]);
  }

  const now = new Date().toISOString();
  const moved = moveOpenTasks
    ? await moveLeadTasksStatements(db, scope, { leadId: id, fromOwner: from, toOwner: ownerUserId, leadVersion: version, now })
    : { count: 0, statements: [] };
  const results = await db.batch([
    {
      sql: `UPDATE crm_leads SET owner_user_id = ?, version = version + 1, last_activity_at = ?, updated_at = ?
            WHERE id = ? AND school_id = ? AND version = ? AND archived_at IS NULL`,
      args: [ownerUserId, now, now, id, scope.schoolId, version],
    },
    auditStatement(scope, {
      action: 'lead.owner_changed',
      entityId: id,
      summary: { fromOwnerUserId: from, toOwnerUserId: ownerUserId },
      onlyIfChanged: true,
      now,
    }),
    ...moved.statements,
  ], 'write');
  await assertVersionedWrite(results, 0, () => currentVersion(db, scope, id));
  return { ...(await loadLead(db, scope, id)), movedTaskCount: moved.count };
}

/** Edits lead details. Contact details are edited through contacts (S4). */
export async function updateLead({ db, scope, input }) {
  const { leadId: id, expectedVersion: version, ...changes } = input.body;
  const sets = [];
  const args = [];
  const fields = [];
  if (changes.learnerName !== undefined) { sets.push('learner_name = ?'); args.push(changes.learnerName); fields.push('learnerName'); }
  if (changes.learnerGrade !== undefined) { sets.push('learner_grade = ?'); args.push(changes.learnerGrade || null); fields.push('learnerGrade'); }
  if (changes.sourceKey !== undefined) {
    if (changes.sourceKey) await ensureLeadSources(db, scope.schoolId);
    sets.push('source_id = ?'); args.push(changes.sourceKey ? `src_${scope.schoolId}_${changes.sourceKey}` : null); fields.push('sourceKey');
  }
  if (changes.interest !== undefined) { sets.push('interest_json = ?'); args.push(interestJson(changes.interest)); fields.push('interest'); }
  if (!sets.length) throw crmErrors.validation([{ path: '', message: 'Nothing to update' }]);

  const now = new Date().toISOString();
  const results = await db.batch([
    {
      sql: `UPDATE crm_leads SET ${sets.join(', ')}, version = version + 1, last_activity_at = ?, updated_at = ?
            WHERE id = ? AND school_id = ? AND version = ? AND archived_at IS NULL`,
      args: [...args, now, now, id, scope.schoolId, version],
    },
    auditStatement(scope, { action: 'lead.updated', entityId: id, summary: { fields }, onlyIfChanged: true, now }),
  ], 'write');
  await assertVersionedWrite(results, 0, () => currentVersion(db, scope, id));
  return loadLead(db, scope, id);
}
