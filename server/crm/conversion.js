// Lead → student conversion (CRM-011, FLKRM-326 S5, D1–D5,
// CRM_CONTRACTS §1.3). Never automatic: the preview lists exact-match
// candidates and staff choose to link one or create a new student; creating
// while candidates exist needs `confirmNoMatch`. Conversion is roster-only (no
// login), enrolls through the chosen batches' academic year, carries the
// lead's contact over as a guardian, and moves the lead to the won stage — all
// in one batch that only applies if the lead is still unconverted at the
// expected version. Repeating a link to the same student returns the same
// result; any other target for a converted lead is a 409.
import crypto from 'node:crypto';
import { z } from 'zod';
import { REQUIREMENTS, convertLeadBody, parseRequirements } from '../../shared/crm/conversion.js';
import { normalizePersonName } from '../../shared/crm/leads.js';
import { assertTransition } from '../../shared/crm/lifecycles.js';
import { auditStatement } from './audit.js';
import { versionConflict } from './concurrency.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { can } from './permissions.js';
import { ensureDefaultPipeline } from './pipeline.js';

export { convertLeadBody };
export const conversionQuery = z.object({ leadId: z.string().min(1).max(128) }).strict();

const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

function requireAccess(scope) {
  // Candidates name existing students, so conversion needs student read too.
  if (!can(scope, 'crm.leads.convert') || !can(scope, 'crm.students.read')) throw crmErrors.forbidden();
}

async function loadLead(db, scope, leadId) {
  const result = await db.execute({
    sql: `SELECT l.id, l.pipeline_id, l.stage_id, l.learner_name, l.learner_grade, l.source_id, l.owner_user_id, l.primary_contact_id,
                 l.interest_json, l.converted_student_id, l.version, st.category AS stage_category,
                 c.phone_e164 AS contact_phone, c.full_name AS contact_name,
                 EXISTS (SELECT 1 FROM crm_lead_stage_events e JOIN crm_pipeline_stages es ON es.id = e.to_stage_id
                         WHERE e.lead_id = l.id AND e.school_id = l.school_id AND es.category = 'applicant') AS reached_applicant
          FROM crm_leads l
          JOIN crm_pipeline_stages st ON st.id = l.stage_id AND st.school_id = l.school_id
          LEFT JOIN crm_contacts c ON c.id = l.primary_contact_id AND c.school_id = l.school_id AND c.anonymised_at IS NULL
          WHERE l.id = ? AND l.school_id = ? AND l.archived_at IS NULL`,
    args: [leadId, scope.schoolId],
  });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

/** Which of the school's switched-on requirements this lead meets (D5). */
async function checkRequirements(db, scope, lead) {
  const pipeline = await db.execute({ sql: 'SELECT requirements_json FROM crm_pipelines WHERE id = ? AND school_id = ?', args: [lead.pipeline_id, scope.schoolId] });
  const on = parseRequirements(pipeline.rows[0]?.requirements_json);
  const met = {
    guardianPhone: Boolean(lead.contact_phone),
    learnerGrade: Boolean(lead.learner_grade),
    source: Boolean(lead.source_id),
    applicantStage: lead.stage_category === 'applicant' || Number(lead.reached_applicant) === 1,
  };
  return REQUIREMENTS.filter((item) => on[item.key]).map((item) => ({ key: item.key, label: item.label, met: met[item.key] }));
}

/**
 * Existing students who may be this learner (CRM_CONTRACTS §1.3): the lead's
 * parent is already an active guardian, or the normalised name is identical.
 * Listed with the reason; never chosen automatically.
 */
async function findCandidates(db, scope, lead) {
  const found = new Map();
  const add = (row, reason) => {
    const item = found.get(row.id) || { studentId: row.id, name: row.display_name, status: row.status, reasons: [] };
    if (!item.reasons.includes(reason)) item.reasons.push(reason);
    found.set(row.id, item);
  };
  if (lead.primary_contact_id) {
    const byGuardian = await db.execute({
      sql: `SELECT DISTINCT s.id, s.display_name, s.status FROM crm_guardian_links g
            JOIN students s ON s.id = g.student_id AND s.school_id = g.school_id AND s.status != 'archived'
            WHERE g.school_id = ? AND g.contact_id = ? AND g.status = 'active'`,
      args: [scope.schoolId, lead.primary_contact_id],
    });
    for (const row of byGuardian.rows) add(row, 'phone');
  }
  const name = normalizePersonName(lead.learner_name);
  if (name) {
    const students = await db.execute({ sql: "SELECT id, display_name, status FROM students WHERE school_id = ? AND status != 'archived'", args: [scope.schoolId] });
    for (const row of students.rows) if (normalizePersonName(row.display_name) === name) add(row, 'name');
  }
  const items = [...found.values()];
  if (items.length) {
    const ids = items.map((item) => item.studentId);
    const batches = await db.execute({
      sql: `SELECT m.student_id, b.name FROM batch_memberships m JOIN batches b ON b.id = m.batch_id AND b.school_id = ?
            WHERE m.status = 'active' AND m.student_id IN (${ids.map(() => '?').join(', ')}) ORDER BY b.name`,
      args: [scope.schoolId, ...ids],
    });
    for (const row of batches.rows) (found.get(row.student_id).batches ||= []).push(row.name);
  }
  return items.map((item) => ({ ...item, batches: item.batches || [] }));
}

async function activeBatches(db, scope) {
  const result = await db.execute({
    sql: "SELECT id, name, grade, academic_year, academic_year_id FROM batches WHERE school_id = ? AND status = 'active' ORDER BY name",
    args: [scope.schoolId],
  });
  return result.rows.map((row) => ({
    id: row.id, name: row.name, grade: row.grade || null, academicYear: row.academic_year || null, hasAcademicYear: Boolean(row.academic_year_id), academicYearId: row.academic_year_id || null,
  }));
}

/** Batches whose name mentions the course the family asked about (a pre-fill; staff confirm). */
function suggestBatches(batches, lead) {
  let course = '';
  try { course = String(JSON.parse(lead.interest_json || '{}').course || '').trim().toLowerCase(); } catch { course = ''; }
  if (!course) return [];
  return batches.filter((batch) => batch.name.toLowerCase().includes(course) || course.includes(batch.name.toLowerCase())).map((batch) => batch.id);
}

export async function conversionPreview({ db, scope, input }) {
  requireAccess(scope);
  const lead = await loadLead(db, scope, input.query.leadId);
  const [requirements, candidates, batches] = await Promise.all([
    checkRequirements(db, scope, lead),
    lead.converted_student_id ? [] : findCandidates(db, scope, lead),
    activeBatches(db, scope),
  ]);
  return {
    leadId: lead.id,
    learnerName: lead.learner_name,
    learnerGrade: lead.learner_grade || null,
    version: Number(lead.version),
    convertedStudentId: lead.converted_student_id || null,
    canConvert: ['open', 'applicant'].includes(lead.stage_category),
    hasContact: Boolean(lead.primary_contact_id),
    requirements,
    candidates,
    batches: batches.map(({ academicYearId: _hidden, ...batch }) => batch),
    suggestedBatchIds: suggestBatches(batches, lead),
  };
}

/**
 * Guard appended to every write in the batch: the lead now points at this
 * student at the version the lead UPDATE produced. If that UPDATE matched
 * nothing (stale version, already converted), every other write is a no-op.
 */
function guard(lead, studentId) {
  return {
    sql: 'EXISTS (SELECT 1 FROM crm_leads WHERE id = ? AND converted_student_id = ? AND version = ?)',
    args: [lead.id, studentId, Number(lead.version) + 1],
  };
}

function guardedInsert(table, columns, values, gate) {
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')} WHERE ${gate.sql}`,
    args: [...values, ...gate.args],
  };
}

export async function convertLead({ db, scope, input }) {
  requireAccess(scope);
  const body = input.body;
  const lead = await loadLead(db, scope, body.leadId);

  // Already converted: the same student again is a harmless repeat.
  if (lead.converted_student_id) {
    if (body.mode === 'link' && body.studentId === lead.converted_student_id) {
      return { studentId: lead.converted_student_id, mode: 'linked', alreadyConverted: true };
    }
    throw new CrmHttpError(409, 'already_converted', 'This lead has already been converted', { studentId: lead.converted_student_id });
  }
  if (Number(lead.version) !== body.expectedVersion) throw versionConflict(Number(lead.version));
  assertTransition('leadStage', lead.stage_category, 'won', { via: 'convert' });

  const unmet = (await checkRequirements(db, scope, lead)).filter((item) => !item.met);
  if (unmet.length) {
    throw new CrmHttpError(422, 'requirements_not_met', `Missing before enrollment: ${unmet.map((item) => item.label).join('; ')}`, { missing: unmet.map((item) => item.key) });
  }

  const candidates = await findCandidates(db, scope, lead);
  if (body.mode === 'create' && candidates.length && !body.confirmNoMatch) {
    throw new CrmHttpError(409, 'possible_match', 'This learner may already be a student. Link them, or confirm this is someone new.', { candidates });
  }

  // Batches: all active in this school; the enrollment year comes from the first with one (D2).
  const allBatches = await activeBatches(db, scope);
  const chosen = body.batchIds.map((id) => allBatches.find((batch) => batch.id === id));
  if (chosen.some((batch) => !batch)) throw crmErrors.validation([{ path: 'batchIds', message: 'Choose active batches from this school' }]);
  const yearBatch = chosen.find((batch) => batch.academicYearId);
  if (!yearBatch) {
    throw new CrmHttpError(422, 'academic_year_required', 'Set an academic year on the chosen batch before enrolling (Classes → batch settings).');
  }
  const standard = yearBatch.grade || lead.learner_grade;
  if (!standard) throw new CrmHttpError(422, 'standard_required', 'Set a grade on the batch or on the lead before enrolling.');

  let student;
  if (body.mode === 'link') {
    const found = await db.execute({
      sql: "SELECT id, status FROM students WHERE id = ? AND school_id = ? AND status != 'archived'",
      args: [body.studentId, scope.schoolId],
    });
    student = found.rows[0];
    if (!student) throw crmErrors.notFound();
    const taken = await db.execute({ sql: 'SELECT id FROM crm_leads WHERE converted_student_id = ? AND id != ?', args: [student.id, lead.id] });
    if (taken.rows.length) throw new CrmHttpError(409, 'student_already_linked', 'This student is already linked to another lead');
    // Linking re-admits an inactive or alumni student.
    if (student.status !== 'active') assertTransition('studentStatus', student.status, 'active');
  }

  const pipelineId = await ensureDefaultPipeline(db, scope.schoolId);
  const won = await db.execute({
    sql: "SELECT id FROM crm_pipeline_stages WHERE pipeline_id = ? AND school_id = ? AND category = 'won' AND archived_at IS NULL ORDER BY position LIMIT 1",
    args: [pipelineId, scope.schoolId],
  });
  const wonStageId = won.rows[0]?.id;
  if (!wonStageId) throw new CrmHttpError(409, 'pipeline_misconfigured', 'The pipeline has no Enrolled stage');

  const now = new Date().toISOString();
  const studentId = student ? student.id : newId('student');
  const gate = guard(lead, studentId);
  const mode = student ? 'linked' : 'created';
  const statements = [
    // 1. The lead: only if still unconverted at the version the dialog saw.
    {
      sql: `UPDATE crm_leads SET stage_id = ?, converted_student_id = ?, converted_at = ?, lost_reason = NULL, lost_reason_key = NULL, lost_at = NULL,
                   version = version + 1, last_activity_at = ?, updated_at = ?
            WHERE id = ? AND school_id = ? AND version = ? AND converted_student_id IS NULL AND archived_at IS NULL`,
      args: [wonStageId, studentId, now, now, now, lead.id, scope.schoolId, body.expectedVersion],
    },
  ];

  if (!student) {
    const school = await db.execute({ sql: 'SELECT display_name FROM schools WHERE id = ?', args: [scope.schoolId] });
    statements.push(guardedInsert('students',
      ['id', 'school', 'display_name', 'school_id', 'user_id', 'roster_key', 'status', 'created_at', 'updated_at'],
      [studentId, school.rows[0]?.display_name || scope.schoolName || '', lead.learner_name, scope.schoolId, null, null, 'active', now, now], gate));
  } else if (student.status !== 'active') {
    statements.push({
      sql: `UPDATE students SET status = 'active', updated_at = ? WHERE id = ? AND school_id = ? AND ${gate.sql}`,
      args: [now, studentId, scope.schoolId, ...gate.args],
    });
  }

  // Batch memberships (skipping ones already active) and the year's enrollment.
  for (const batch of chosen) {
    statements.push({
      sql: `INSERT INTO batch_memberships (id, batch_id, student_id, status, joined_at, left_at, created_at, updated_at)
            SELECT ?, ?, ?, 'active', ?, NULL, ?, ? WHERE ${gate.sql}
              AND NOT EXISTS (SELECT 1 FROM batch_memberships WHERE batch_id = ? AND student_id = ? AND status = 'active')`,
      args: [newId('membership'), batch.id, studentId, now, now, now, ...gate.args, batch.id, studentId],
    });
  }
  // An existing enrollment for that year is kept, not overwritten (D2).
  statements.push({
    sql: `INSERT INTO student_enrollments (id, student_id, academic_year_id, standard, status, created_at, updated_at)
          SELECT ?, ?, ?, ?, 'active', ?, ? WHERE ${gate.sql}
            AND NOT EXISTS (SELECT 1 FROM student_enrollments WHERE student_id = ? AND academic_year_id = ?)`,
    args: [newId('enrollment'), studentId, yearBatch.academicYearId, standard, now, now, ...gate.args, studentId, yearBatch.academicYearId],
  });

  // CRM profile: owner and where the student came from, without overwriting.
  statements.push(
    {
      sql: `INSERT OR IGNORE INTO crm_student_profiles (student_id, school_id, owner_user_id, converted_from_lead_id, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ? WHERE ${gate.sql}`,
      args: [studentId, scope.schoolId, lead.owner_user_id || null, lead.id, now, now, ...gate.args],
    },
    {
      sql: `UPDATE crm_student_profiles SET converted_from_lead_id = COALESCE(converted_from_lead_id, ?), owner_user_id = COALESCE(owner_user_id, ?), updated_at = ?
            WHERE student_id = ? AND school_id = ? AND ${gate.sql}`,
      args: [lead.id, lead.owner_user_id || null, now, studentId, scope.schoolId, ...gate.args],
    },
  );

  // The lead's contact becomes a guardian (D4): primary + fee payer when the
  // student has no guardian yet, otherwise an extra guardian. Never replaces.
  let guardian = null;
  if (lead.primary_contact_id) {
    const links = await db.execute({
      sql: 'SELECT id, contact_id, status FROM crm_guardian_links WHERE school_id = ? AND student_id = ?',
      args: [scope.schoolId, studentId],
    });
    const active = links.rows.filter((row) => row.status === 'active');
    const existing = links.rows.find((row) => row.contact_id === lead.primary_contact_id);
    const first = active.length === 0;
    if (!existing || existing.status !== 'active') {
      const linkId = existing ? existing.id : newId('gl');
      guardian = { linkId, contactId: lead.primary_contact_id, change: existing ? 'restored' : 'added' };
      statements.push(existing
        ? {
          sql: `UPDATE crm_guardian_links SET status = 'active', removed_at = NULL, relationship = ?, is_primary = ?, is_fee_payer = ?, version = version + 1, updated_at = ?
                WHERE id = ? AND school_id = ? AND ${gate.sql}`,
          args: [body.relationship, first ? 1 : 0, first ? 1 : 0, now, linkId, scope.schoolId, ...gate.args],
        }
        : guardedInsert('crm_guardian_links',
          ['id', 'school_id', 'student_id', 'contact_id', 'relationship', 'is_primary', 'is_emergency', 'is_fee_payer', 'created_at', 'updated_at'],
          [linkId, scope.schoolId, studentId, lead.primary_contact_id, body.relationship, first ? 1 : 0, 0, first ? 1 : 0, now, now], gate));
    }
  }

  // History and audit, kept on the lead (CRM_CONTRACTS §1.3).
  statements.push(
    guardedInsert('crm_lead_stage_events',
      ['id', 'school_id', 'lead_id', 'from_stage_id', 'to_stage_id', 'actor_user_id', 'reason', 'created_at'],
      [newId('lse'), scope.schoolId, lead.id, lead.stage_id, wonStageId, scope.actor.user_id || null, mode === 'created' ? 'Converted to a new student' : 'Linked to an existing student', now], gate),
    auditStatement(scope, { action: 'lead.converted', entityId: lead.id, summary: { studentId, mode }, when: gate, now }),
  );
  if (guardian) {
    statements.push(auditStatement(scope, {
      action: 'guardian.changed', entityId: studentId, summary: { change: guardian.change, linkId: guardian.linkId, contactId: guardian.contactId }, when: gate, now,
    }));
  }

  let results;
  try {
    results = await db.batch(statements, 'write');
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''))) {
      throw new CrmHttpError(409, 'version_conflict', 'This lead or student changed at the same moment. Reload and try again.');
    }
    throw error;
  }
  if (!Number(results[0].rowsAffected)) {
    const now2 = await loadLead(db, scope, lead.id);
    if (now2.converted_student_id) throw new CrmHttpError(409, 'already_converted', 'This lead has already been converted', { studentId: now2.converted_student_id });
    throw versionConflict(Number(now2.version));
  }
  return { studentId, mode, alreadyConverted: false };
}
