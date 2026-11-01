// Notes on leads and students (CRM-007, FLKRM-326 S3/S4, D14, D14a). Anyone
// who can see the record can read its notes. Adding needs write access on a
// lead, but only read access on a student, so teachers can note what they see.
// Only the author can edit; the author or a school admin (settings access) can
// remove. Removal is a soft delete that leaves a "note removed" entry on the
// timeline. Audit rows never hold the text.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { addNoteBody, noteBodyField, recordRef } from '../../shared/crm/notes.js';
import { auditStatement } from './audit.js';
import { assertVersionedWrite, expectedVersion } from './concurrency.js';
import { crmErrors } from './errors.js';
import { can } from './permissions.js';
import { assertRecord, touchStatement } from './records.js';

export { addNoteBody };

const noteId = z.string().min(1).max(128);
export const listNotesQuery = z.object(recordRef).strict();
export const editNoteBody = z.object({ noteId, body: noteBodyField, expectedVersion }).strict();
export const removeNoteBody = z.object({ noteId, expectedVersion }).strict();

// Removing someone else's note is an admin action (D14).
const MODERATE = 'crm.settings.manage';

/** Access needed to add, edit or remove your own note on a record (D14a). */
function noteMode(entityType) {
  return entityType === 'student' ? 'read' : 'write';
}

function serializeNote(row, scope) {
  const mine = Boolean(row.author_user_id) && row.author_user_id === scope.actor.user_id;
  return {
    id: row.id,
    body: row.body,
    author: row.author_user_id ? { userId: row.author_user_id, name: row.author_name || null } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: Number(row.version) > 1,
    version: Number(row.version),
    canEdit: mine,
    canRemove: mine || can(scope, MODERATE),
  };
}

const NOTE_SELECT = `
  SELECT n.id, n.entity_type, n.entity_id, n.body, n.author_user_id, n.version, n.created_at, n.updated_at,
         u.display_name AS author_name
  FROM crm_notes n LEFT JOIN users u ON u.id = n.author_user_id`;

export async function listNotes({ db, scope, input }) {
  const { entityType, entityId } = input.query;
  await assertRecord(db, scope, entityType, entityId, 'read');
  const result = await db.execute({
    sql: `${NOTE_SELECT}
          WHERE n.school_id = ? AND n.entity_type = ? AND n.entity_id = ? AND n.archived_at IS NULL AND n.anonymised_at IS NULL
          ORDER BY n.created_at DESC, n.id DESC LIMIT 200`,
    args: [scope.schoolId, entityType, entityId],
  });
  return { items: result.rows.map((row) => serializeNote(row, scope)), nextCursor: null };
}

async function loadNoteRow(db, scope, id) {
  const result = await db.execute({
    sql: `${NOTE_SELECT} WHERE n.id = ? AND n.school_id = ? AND n.archived_at IS NULL AND n.anonymised_at IS NULL`,
    args: [id, scope.schoolId],
  });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

function noteAudit(scope, row, change, now) {
  return auditStatement(scope, {
    action: 'note.changed',
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: { change, noteId: row.id },
    onlyIfChanged: change !== 'added',
    now,
  });
}

export async function addNote({ db, scope, input }) {
  const { entityType, entityId, body } = input.body;
  await assertRecord(db, scope, entityType, entityId, noteMode(entityType));
  const now = new Date().toISOString();
  const id = `note_${randomUUID()}`;
  await db.batch([
    {
      sql: `INSERT INTO crm_notes (id, school_id, entity_type, entity_id, body, author_user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, scope.schoolId, entityType, entityId, body, scope.actor.user_id || null, now, now],
    },
    noteAudit(scope, { id, entity_type: entityType, entity_id: entityId }, 'added', now),
    touchStatement(scope, entityType, entityId, now),
  ].filter(Boolean), 'write');
  return serializeNote(await loadNoteRow(db, scope, id), scope);
}

async function guardedNoteWrite(db, scope, row, { set, args, change, version }) {
  const now = new Date().toISOString();
  const results = await db.batch([
    {
      sql: `UPDATE crm_notes SET ${set}, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND version = ? AND archived_at IS NULL`,
      args: [...args, now, row.id, scope.schoolId, version],
    },
    noteAudit(scope, row, change, now),
  ], 'write');
  await assertVersionedWrite(results, 0, async () => {
    const current = await db.execute({ sql: 'SELECT version FROM crm_notes WHERE id = ? AND school_id = ? AND archived_at IS NULL', args: [row.id, scope.schoolId] });
    return current.rows[0]?.version ?? null;
  });
}

export async function editNote({ db, scope, input }) {
  const { noteId: id, body, expectedVersion: version } = input.body;
  const row = await loadNoteRow(db, scope, id);
  await assertRecord(db, scope, row.entity_type, row.entity_id, noteMode(row.entity_type));
  // Nobody rewrites someone else's words, admins included (D14).
  if (row.author_user_id !== scope.actor.user_id) throw crmErrors.forbidden();
  if (row.body === body) throw crmErrors.validation([{ path: 'body', message: 'Nothing changed' }]);
  await guardedNoteWrite(db, scope, row, { set: 'body = ?', args: [body], change: 'edited', version });
  return serializeNote(await loadNoteRow(db, scope, id), scope);
}

export async function removeNote({ db, scope, input }) {
  const { noteId: id, expectedVersion: version } = input.body;
  const row = await loadNoteRow(db, scope, id);
  const mine = row.author_user_id === scope.actor.user_id;
  if (mine) await assertRecord(db, scope, row.entity_type, row.entity_id, noteMode(row.entity_type));
  else {
    if (!can(scope, MODERATE)) throw crmErrors.forbidden();
    // A moderator still has to be able to see the record the note is on.
    await assertRecord(db, scope, row.entity_type, row.entity_id, 'read');
  }
  await guardedNoteWrite(db, scope, row, { set: 'archived_at = ?', args: [new Date().toISOString()], change: 'removed', version });
  return { id, removed: true };
}
