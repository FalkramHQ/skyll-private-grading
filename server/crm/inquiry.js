// Public inquiry form (CRM-009, FLKRM-326 S6, D8, D9) and its settings.
//
// The public routes are the CRM's only unauthenticated endpoints. The school
// comes from the URL slug alone (never the body), and an unknown school, a
// school without the CRM, and a school with the form off all get the same 404.
// Submissions are rate limited per address and per school; a filled honeypot
// gets the normal reply but saves nothing. A repeat inquiry for an open lead
// (same parent phone and learner) adds a note to that lead instead of a new one.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkRateLimit } from '../../api/_lib/rateLimit.js';
import { normalizePhone } from '../../api/_lib/phone.js';
import { INQUIRY_LIMITS, inquiryBody, inquirySettingsBody } from '../../shared/crm/inquiry.js';
import { normalizePersonName } from '../../shared/crm/leads.js';
import { DEFAULT_TIMEZONE } from '../../shared/crm/time.js';
import { auditStatement } from './audit.js';
import { versionConflict } from './concurrency.js';
import { contactStatements } from './contacts.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { assertAssignable, crmMembers, membersWith } from './members.js';
import { ensureLeadSources } from './leads.js';
import { ensureDefaultPipeline } from './pipeline.js';
import { followUpTaskStatements } from './tasks.js';
import { parseInput } from './validation.js';

const HOUR_MS = 60 * 60 * 1000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const OWNER_CAPABILITY = 'crm.leads.write';

// Not strict, and the slug is checked in the handler, so a bad link is a plain 404.
export const publicInquiryQuery = z.object({ school: z.string().max(100).optional() });
export const inquirySettingsQuery = z.object({}).strict();
export { inquirySettingsBody };

/** The school behind `slug`, only when its CRM and its inquiry form are both on. */
async function publicSchool(db, slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw crmErrors.notFound();
  const result = await db.execute({
    sql: `SELECT s.id, s.display_name, s.timezone, i.default_owner_user_id
          FROM schools s
          JOIN school_feature_flags f ON f.school_id = s.id AND f.feature_key = 'crm' AND f.enabled = 1
          JOIN crm_inquiry_settings i ON i.school_id = s.id AND i.enabled = 1
          WHERE s.slug = ? AND s.status = 'active'`,
    args: [slug],
  });
  const row = result.rows[0];
  if (!row) throw crmErrors.notFound();
  return row;
}

// Writes from the form have no signed-in person behind them.
function publicScope(school) {
  return {
    schoolId: school.id,
    schoolName: school.display_name,
    timezone: school.timezone || DEFAULT_TIMEZONE,
    actor: { user_id: null, role: 'public' },
    capabilities: new Set(),
    grants: new Set(),
    support: false,
  };
}

// Same rightmost-hop rule as the login limiter: the left of x-forwarded-for is client-supplied.
export function clientAddress(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',').pop().trim();
  return forwarded || String(req.headers?.['x-real-ip'] || '').trim() || req.socket?.remoteAddress || 'unknown';
}

async function assertWithinLimits(req, schoolId) {
  const address = createHash('sha256').update(clientAddress(req)).digest('hex').slice(0, 32);
  const [perAddress, perSchool] = await Promise.all([
    checkRateLimit(`crm-inquiry:${schoolId}:${address}`, { max: INQUIRY_LIMITS.perIpPerHour, windowMs: HOUR_MS }),
    checkRateLimit(`crm-inquiry:${schoolId}`, { max: INQUIRY_LIMITS.perSchoolPerHour, windowMs: HOUR_MS }),
  ]);
  if (perAddress || perSchool) throw new CrmHttpError(429, 'rate_limited', 'Too many inquiries right now. Please try again in an hour.');
}

/** The owner for form leads, or null when the chosen one can no longer own leads. */
async function eligibleOwner(db, schoolId, userId) {
  if (!userId) return null;
  const [member] = await crmMembers(db, schoolId, { userIds: [userId] });
  return member?.capabilities.has(OWNER_CAPABILITY) ? userId : null;
}

function inquiryNote(body, { repeat }) {
  const lines = [repeat ? 'Re-submitted inquiry from the website form.' : 'Inquiry from the website form.'];
  if (body.learnerGrade) lines.push(`Grade: ${body.learnerGrade}`);
  if (body.course) lines.push(`Interested in: ${body.course}`);
  if (body.schedule) lines.push(`Preferred timing: ${body.schedule}`);
  if (body.message) lines.push(`Message: ${body.message}`);
  // The note's own timestamp records when consent was given.
  lines.push('Consent: the parent agreed to be contacted about admissions.');
  lines.push(`WhatsApp updates: ${body.whatsappOptIn ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function noteStatement(scope, leadId, body, now) {
  return {
    sql: `INSERT INTO crm_notes (id, school_id, entity_type, entity_id, body, author_user_id, created_at, updated_at)
          VALUES (?, ?, 'lead', ?, ?, NULL, ?, ?)`,
    args: [`note_${randomUUID()}`, scope.schoolId, leadId, body, now, now],
  };
}

/** An open, unconverted lead for the same parent phone and learner, if any. */
async function openLeadFor(db, scope, phoneE164, learnerName) {
  const result = await db.execute({
    sql: `SELECT l.id, l.learner_name, l.owner_user_id
          FROM crm_leads l
          JOIN crm_contacts c ON c.id = l.primary_contact_id AND c.school_id = l.school_id
          JOIN crm_pipeline_stages st ON st.id = l.stage_id AND st.school_id = l.school_id
          WHERE l.school_id = ? AND c.phone_e164 = ? AND l.archived_at IS NULL AND l.converted_student_id IS NULL
            AND st.category IN ('open', 'applicant')
          ORDER BY l.created_at DESC`,
    args: [scope.schoolId, phoneE164],
  });
  const wanted = normalizePersonName(learnerName);
  return result.rows.find((row) => normalizePersonName(row.learner_name) === wanted) || null;
}

async function hasOpenTask(db, scope, leadId) {
  const result = await db.execute({
    sql: "SELECT 1 FROM crm_tasks WHERE school_id = ? AND related_type = 'lead' AND related_id = ? AND status = 'open' LIMIT 1",
    args: [scope.schoolId, leadId],
  });
  return result.rows.length > 0;
}

async function firstOpenStage(db, scope, pipelineId) {
  const result = await db.execute({
    sql: `SELECT id FROM crm_pipeline_stages
          WHERE pipeline_id = ? AND school_id = ? AND category = 'open' AND archived_at IS NULL
          ORDER BY position LIMIT 1`,
    args: [pipelineId, scope.schoolId],
  });
  // A school with no lead stage can't take inquiries; say nothing more to the public.
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0].id;
}

/** GET public/inquiry?school=<slug>: what the form needs to render. */
export async function getPublicInquiry({ db, input }) {
  const school = await publicSchool(db, input.query.school);
  return { school: { name: school.display_name } };
}

/** POST public/inquiry?school=<slug>: always the same reply once accepted. */
export async function submitPublicInquiry({ req, db, input }) {
  const school = await publicSchool(db, input.query.school);
  await assertWithinLimits(req, school.id);
  const accepted = { received: true };
  // Checked before validation so a bot never learns what a valid form looks like.
  if (typeof req.body?.website === 'string' && req.body.website.trim()) return accepted;
  const body = parseInput(inquiryBody, req.body);

  const scope = publicScope(school);
  const now = new Date().toISOString();
  const phoneE164 = normalizePhone(body.parentPhone);
  const defaultOwner = await eligibleOwner(db, scope.schoolId, school.default_owner_user_id);
  const contact = await contactStatements(db, {
    schoolId: scope.schoolId,
    name: body.parentName,
    phone: body.parentPhone,
    optedIn: body.whatsappOptIn === true,
    consentSource: 'public_form',
    now,
  });
  if (!phoneE164 || !contact) throw crmErrors.validation([{ path: 'parentPhone', message: 'Enter a valid phone number' }]);
  // Anyone can type any number, so the form never changes a contact already on
  // file: WhatsApp opt-in is recorded only for a new contact (staff can confirm
  // it for existing ones). The note keeps what the parent asked for.
  if (contact.existing) contact.statements = [];

  const existing = await openLeadFor(db, scope, phoneE164, body.learnerName);
  if (existing) {
    const owner = (await eligibleOwner(db, scope.schoolId, existing.owner_user_id)) || defaultOwner;
    const statements = [
      ...contact.statements,
      noteStatement(scope, existing.id, inquiryNote(body, { repeat: true }), now),
      { sql: 'UPDATE crm_leads SET last_activity_at = ? WHERE id = ? AND school_id = ?', args: [now, existing.id, scope.schoolId] },
    ];
    if (!(await hasOpenTask(db, scope, existing.id))) {
      statements.push(...followUpTaskStatements(scope, { leadId: existing.id, learnerName: existing.learner_name, ownerUserId: owner, now }));
    }
    await db.batch(statements, 'write');
    return accepted;
  }

  const pipelineId = await ensureDefaultPipeline(db, scope.schoolId, now);
  await ensureLeadSources(db, scope.schoolId, now);
  const stageId = await firstOpenStage(db, scope, pipelineId);
  const id = `lead_${randomUUID()}`;
  const interest = {};
  if (body.course) interest.course = body.course;
  if (body.schedule) interest.schedule = body.schedule;
  await db.batch([
    ...contact.statements,
    {
      sql: `INSERT INTO crm_leads (id, school_id, pipeline_id, stage_id, primary_contact_id, learner_name, learner_grade,
                                   interest_json, source_id, owner_user_id, last_activity_at, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      args: [
        id, scope.schoolId, pipelineId, stageId, contact.contactId, body.learnerName, body.learnerGrade || null,
        JSON.stringify(interest), `src_${scope.schoolId}_website`, defaultOwner, now, now, now,
      ],
    },
    {
      sql: `INSERT INTO crm_lead_stage_events (id, school_id, lead_id, from_stage_id, to_stage_id, actor_user_id, reason, created_at)
            VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?)`,
      args: [`lse_${randomUUID()}`, scope.schoolId, id, stageId, now],
    },
    auditStatement(scope, {
      action: 'lead.created',
      entityId: id,
      summary: { stageId, channel: 'public_form', sourceKey: 'website', duplicateOverride: false },
      now,
    }),
    noteStatement(scope, id, inquiryNote(body, { repeat: false }), now),
    ...followUpTaskStatements(scope, { leadId: id, learnerName: body.learnerName, ownerUserId: defaultOwner, now }),
  ], 'write');
  return accepted;
}

async function settingsRow(db, schoolId) {
  const result = await db.execute({
    sql: 'SELECT enabled, default_owner_user_id, version FROM crm_inquiry_settings WHERE school_id = ?',
    args: [schoolId],
  });
  return result.rows[0] || null;
}

async function loadSettings(db, scope) {
  const [row, slug, owners] = await Promise.all([
    settingsRow(db, scope.schoolId),
    db.execute({ sql: 'SELECT slug FROM schools WHERE id = ?', args: [scope.schoolId] }),
    membersWith(db, scope.schoolId, OWNER_CAPABILITY),
  ]);
  const ownerId = row?.default_owner_user_id || null;
  const owner = owners.find((member) => member.userId === ownerId) || null;
  return {
    enabled: Number(row?.enabled || 0) === 1,
    defaultOwnerUserId: ownerId,
    // Leads from the form start unowned while the chosen owner can't take them.
    ownerEligible: Boolean(owner),
    owners,
    publicPath: slug.rows[0]?.slug ? `/inquire/${slug.rows[0].slug}` : null,
    version: Number(row?.version || 0),
  };
}

/** GET settings/inquiry */
export async function getInquirySettings({ db, scope }) {
  return loadSettings(db, scope);
}

/** POST settings/inquiry: turn the form on or off and choose who gets new inquiries. */
export async function updateInquirySettings({ db, scope, input }) {
  const { enabled, defaultOwnerUserId, expectedVersion } = input.body;
  if (defaultOwnerUserId) await assertAssignable(db, scope.schoolId, defaultOwnerUserId, OWNER_CAPABILITY);
  const now = new Date().toISOString();
  const current = await settingsRow(db, scope.schoolId);
  const currentVersion = Number(current?.version || 0);
  if (expectedVersion !== currentVersion) throw versionConflict(currentVersion);

  const write = current
    ? {
      sql: `UPDATE crm_inquiry_settings SET enabled = ?, default_owner_user_id = ?, updated_by = ?, updated_at = ?, version = version + 1
            WHERE school_id = ? AND version = ?`,
      args: [enabled ? 1 : 0, defaultOwnerUserId, scope.actor.user_id || null, now, scope.schoolId, expectedVersion],
    }
    : {
      sql: `INSERT OR IGNORE INTO crm_inquiry_settings (school_id, enabled, default_owner_user_id, version, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?, ?)`,
      args: [scope.schoolId, enabled ? 1 : 0, defaultOwnerUserId, scope.actor.user_id || null, now, now],
    };
  const results = await db.batch([
    write,
    auditStatement(scope, {
      action: 'inquiry_form.changed',
      entityId: scope.schoolId,
      summary: { enabled, defaultOwnerUserId },
      onlyIfChanged: true,
      now,
    }),
  ], 'write');
  if (Number(results[0]?.rowsAffected || 0) === 0) {
    throw versionConflict(Number((await settingsRow(db, scope.schoolId))?.version || 0));
  }
  return loadSettings(db, scope);
}
