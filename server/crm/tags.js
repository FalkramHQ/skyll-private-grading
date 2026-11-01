// Tags on leads and students (CRM-007, FLKRM-326 S3, D14). Anyone who can
// change a record can tag it, including creating a new tag by typing its name.
// Renaming, recolouring and archiving live in Settings → Tags. Archived tags
// stay on the records that have them (greyed out) but can't be applied again.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NOTE_ENTITY_TYPES } from '../../shared/crm/notes.js';
import { TAG_COLORS, cleanTagLabel, tagLabelField } from '../../shared/crm/tags.js';
import { auditStatement } from './audit.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { assertRecord, touchStatement } from './records.js';

const tagId = z.string().min(1).max(128);
const recordRef = { entityType: z.enum(NOTE_ENTITY_TYPES), entityId: z.string().min(1).max(128) };

export const listTagsQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional() }).strict();
export const applyTagBody = z.object({ ...recordRef, tagId: tagId.optional(), label: tagLabelField.optional() }).strict()
  .refine((body) => Boolean(body.tagId) !== Boolean(body.label), { message: 'Send either tagId or label' });
export const removeTagBody = z.object({ ...recordRef, tagId }).strict();
export const createTagBody = z.object({ label: tagLabelField, color: z.enum(TAG_COLORS).default('gray') }).strict();
export const updateTagBody = z.object({ tagId, label: tagLabelField.optional(), color: z.enum(TAG_COLORS).optional() }).strict()
  .refine((body) => body.label !== undefined || body.color !== undefined, { message: 'Nothing to change' });
export const archiveTagBody = z.object({ tagId, archived: z.boolean() }).strict();

const duplicateName = () => new CrmHttpError(422, 'duplicate_name', 'A tag with this name already exists', [{ path: 'label', message: 'Choose a different name' }]);

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''));
}

function serializeTag(row) {
  return { id: row.id, label: row.label, color: row.color || 'gray', archived: Boolean(row.archived_at) };
}

/** Tags on each record: `{ [entityId]: [tag, …] }`. Archived tags included, flagged. */
export async function tagsFor(db, scope, entityType, entityIds) {
  if (!entityIds.length) return {};
  const result = await db.execute({
    sql: `SELECT et.entity_id, t.id, t.label, t.color, t.archived_at
          FROM crm_entity_tags et JOIN crm_tags t ON t.id = et.tag_id AND t.school_id = et.school_id
          WHERE et.school_id = ? AND et.entity_type = ? AND et.entity_id IN (${entityIds.map(() => '?').join(', ')})
          ORDER BY t.archived_at IS NOT NULL, lower(t.label)`,
    args: [scope.schoolId, entityType, ...entityIds],
  });
  const map = {};
  for (const row of result.rows) (map[row.entity_id] ||= []).push(serializeTag(row));
  return map;
}

export async function listTags({ db, scope, input }) {
  const includeArchived = input.query.includeArchived === 'true';
  const result = await db.execute({
    sql: `SELECT t.id, t.label, t.color, t.archived_at,
                 (SELECT COUNT(*) FROM crm_entity_tags et WHERE et.tag_id = t.id AND et.school_id = t.school_id) AS usage
          FROM crm_tags t
          WHERE t.school_id = ? ${includeArchived ? '' : 'AND t.archived_at IS NULL'}
          ORDER BY t.archived_at IS NOT NULL, lower(t.label)`,
    args: [scope.schoolId],
  });
  return { items: result.rows.map((row) => ({ ...serializeTag(row), usage: Number(row.usage) })), nextCursor: null };
}

async function loadTag(db, scope, id) {
  const result = await db.execute({ sql: 'SELECT id, label, color, archived_at FROM crm_tags WHERE id = ? AND school_id = ?', args: [id, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

async function activeTagByLabel(db, scope, label) {
  const result = await db.execute({
    sql: 'SELECT id, label, color, archived_at FROM crm_tags WHERE school_id = ? AND lower(label) = lower(?) AND archived_at IS NULL',
    args: [scope.schoolId, label],
  });
  return result.rows[0] || null;
}

/**
 * The school's active tag with this label, created if needed. Concurrent
 * creators race safely: the partial unique index makes the loser's INSERT a
 * no-op and both read back the same row.
 */
async function ensureTag(db, scope, rawLabel, color = 'gray') {
  const label = cleanTagLabel(rawLabel);
  const existing = await activeTagByLabel(db, scope, label);
  if (existing) return existing;
  const now = new Date().toISOString();
  const id = `tag_${randomUUID()}`;
  await db.batch([
    {
      sql: `INSERT OR IGNORE INTO crm_tags (id, school_id, label, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, scope.schoolId, label, color, now, now],
    },
    auditStatement(scope, { action: 'tag.changed', entityId: id, summary: { change: 'created', toLabel: label, color }, onlyIfChanged: true, now }),
  ], 'write');
  return activeTagByLabel(db, scope, label);
}

export async function createTag({ db, scope, input }) {
  const label = cleanTagLabel(input.body.label);
  if (await activeTagByLabel(db, scope, label)) throw duplicateName();
  const tag = await ensureTag(db, scope, label, input.body.color);
  return { ...serializeTag(tag), usage: 0 };
}

export async function applyTag({ db, scope, input }) {
  const { entityType, entityId } = input.body;
  await assertRecord(db, scope, entityType, entityId, 'write');
  let tag;
  if (input.body.label) tag = await ensureTag(db, scope, input.body.label);
  else {
    tag = await loadTag(db, scope, input.body.tagId);
    if (tag.archived_at) throw new CrmHttpError(422, 'tag_archived', 'This tag is archived. Restore it in Settings → Tags first.');
  }
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: `INSERT OR IGNORE INTO crm_entity_tags (school_id, tag_id, entity_type, entity_id, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [scope.schoolId, tag.id, entityType, entityId, scope.actor.user_id || null, now, now],
    },
    auditStatement(scope, {
      action: 'record.tagged', entityType, entityId, summary: { change: 'added', tagId: tag.id, label: tag.label }, onlyIfChanged: true, now,
    }),
    touchStatement(scope, entityType, entityId, now),
  ].filter(Boolean), 'write');
  return { items: (await tagsFor(db, scope, entityType, [entityId]))[entityId] || [] };
}

export async function removeTag({ db, scope, input }) {
  const { entityType, entityId, tagId: id } = input.body;
  await assertRecord(db, scope, entityType, entityId, 'write');
  const tag = await loadTag(db, scope, id);
  const now = new Date().toISOString();
  await db.batch([
    {
      sql: 'DELETE FROM crm_entity_tags WHERE school_id = ? AND tag_id = ? AND entity_type = ? AND entity_id = ?',
      args: [scope.schoolId, id, entityType, entityId],
    },
    auditStatement(scope, {
      action: 'record.tagged', entityType, entityId, summary: { change: 'removed', tagId: id, label: tag.label }, onlyIfChanged: true, now,
    }),
  ], 'write');
  return { items: (await tagsFor(db, scope, entityType, [entityId]))[entityId] || [] };
}

export async function updateTag({ db, scope, input }) {
  const { tagId: id, color } = input.body;
  const tag = await loadTag(db, scope, id);
  const label = input.body.label === undefined ? undefined : cleanTagLabel(input.body.label);
  const now = new Date().toISOString();
  const statements = [];
  if (label !== undefined && label !== tag.label) {
    statements.push(
      { sql: 'UPDATE crm_tags SET label = ?, updated_at = ? WHERE id = ? AND school_id = ?', args: [label, now, id, scope.schoolId] },
      auditStatement(scope, { action: 'tag.changed', entityId: id, summary: { change: 'renamed', fromLabel: tag.label, toLabel: label }, onlyIfChanged: true, now }),
    );
  }
  if (color !== undefined && color !== (tag.color || 'gray')) {
    statements.push(
      { sql: 'UPDATE crm_tags SET color = ?, updated_at = ? WHERE id = ? AND school_id = ?', args: [color, now, id, scope.schoolId] },
      auditStatement(scope, { action: 'tag.changed', entityId: id, summary: { change: 'recolored', color }, onlyIfChanged: true, now }),
    );
  }
  if (!statements.length) throw crmErrors.validation([{ path: '', message: 'Nothing changed' }]);
  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateName();
    throw error;
  }
  return serializeTag(await loadTag(db, scope, id));
}

export async function archiveTag({ db, scope, input }) {
  const { tagId: id, archived } = input.body;
  const tag = await loadTag(db, scope, id);
  if (Boolean(tag.archived_at) === archived) return serializeTag(tag);
  const now = new Date().toISOString();
  try {
    await db.batch([
      { sql: 'UPDATE crm_tags SET archived_at = ?, updated_at = ? WHERE id = ? AND school_id = ?', args: [archived ? now : null, now, id, scope.schoolId] },
      auditStatement(scope, { action: 'tag.changed', entityId: id, summary: { change: archived ? 'archived' : 'restored', toLabel: tag.label }, onlyIfChanged: true, now }),
    ], 'write');
  } catch (error) {
    // Restoring clashes with a newer active tag of the same name.
    if (isUniqueViolation(error)) throw duplicateName();
    throw error;
  }
  return serializeTag(await loadTag(db, scope, id));
}
