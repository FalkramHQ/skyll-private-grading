// Admissions pipeline settings (CRM-001 §1.2, CRM-010 groundwork). Stage
// categories never change through the API; only names and order do.
import crypto from 'node:crypto';
import { z } from 'zod';
import { ADDABLE_CATEGORIES, REQUIREMENT_KEYS, addStageBody, parseRequirements, requirementsField } from '../../shared/crm/conversion.js';
import { assertTransition } from '../../shared/crm/lifecycles.js';
import { DEFAULT_PIPELINE_NAME, DEFAULT_STAGES, STAGE_NAME_MAX } from '../../shared/crm/pipeline.js';
import { auditStatement } from './audit.js';
import { assertVersionedWrite, expectedVersion } from './concurrency.js';
import { CrmHttpError, crmErrors } from './errors.js';

// `.strict()` rejects extra fields such as `category`, so a client can never
// turn a stage into `won` and bypass conversion.
export const renameStageBody = z.object({
  stageId: z.string().min(1).max(160),
  name: z.string().trim().min(1).max(STAGE_NAME_MAX),
  expectedVersion,
}).strict();

export const reorderStagesBody = z.object({
  stageIds: z.array(z.string().min(1).max(160)).min(1).max(50),
  expectedVersion,
}).strict();

export { addStageBody };

export const archiveStageBody = z.object({
  stageId: z.string().min(1).max(160),
  // Where the stage's current leads go; required when it has any.
  destinationStageId: z.string().min(1).max(160).optional(),
  expectedVersion,
}).strict();

export const requirementsBody = z.object({ requirements: requirementsField, expectedVersion }).strict();

export function defaultPipelineId(schoolId) {
  return `pl_${schoolId}_default`;
}

/**
 * Creates the default pipeline and stages the first time a school uses the
 * CRM. Ids are deterministic and inserts are OR IGNORE, so concurrent first
 * requests are harmless and re-runs change nothing.
 */
export async function ensureDefaultPipeline(db, schoolId, now = new Date().toISOString()) {
  const pipelineId = defaultPipelineId(schoolId);
  await db.batch([
    {
      sql: `INSERT OR IGNORE INTO crm_pipelines (id, school_id, name, is_default, version, created_at, updated_at)
            VALUES (?, ?, ?, 1, 1, ?, ?)`,
      args: [pipelineId, schoolId, DEFAULT_PIPELINE_NAME, now, now],
    },
    ...DEFAULT_STAGES.map((stage, position) => ({
      sql: `INSERT OR IGNORE INTO crm_pipeline_stages
            (id, school_id, pipeline_id, stage_key, name, category, position, version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      args: [`${pipelineId}_${stage.key}`, schoolId, pipelineId, stage.key, stage.name, stage.category, position, now, now],
    })),
  ], 'write');
  return pipelineId;
}

async function loadPipeline(db, schoolId, pipelineId) {
  const [pipeline, stages] = await Promise.all([
    db.execute({
      sql: 'SELECT id, name, version, requirements_json FROM crm_pipelines WHERE id = ? AND school_id = ? AND archived_at IS NULL',
      args: [pipelineId, schoolId],
    }),
    db.execute({
      sql: `SELECT st.id, st.stage_key, st.name, st.category, st.position, st.version,
                   (SELECT COUNT(*) FROM crm_leads l WHERE l.stage_id = st.id AND l.school_id = st.school_id AND l.archived_at IS NULL) AS lead_count
            FROM crm_pipeline_stages st
            WHERE st.pipeline_id = ? AND st.school_id = ? AND st.archived_at IS NULL
            ORDER BY st.position, st.id`,
      args: [pipelineId, schoolId],
    }),
  ]);
  const row = pipeline.rows[0];
  if (!row) throw crmErrors.notFound();
  return {
    id: row.id,
    name: row.name,
    version: Number(row.version),
    requirements: parseRequirements(row.requirements_json),
    stages: stages.rows.map((stage) => ({
      id: stage.id,
      key: stage.stage_key || null,
      name: stage.name,
      category: stage.category,
      position: Number(stage.position),
      version: Number(stage.version),
      leadCount: Number(stage.lead_count),
    })),
  };
}

export async function getPipeline({ db, scope }) {
  const pipelineId = await ensureDefaultPipeline(db, scope.schoolId);
  return loadPipeline(db, scope.schoolId, pipelineId);
}

function isUniqueNameViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || '')) && /crm_pipeline_stages/i.test(String(error?.message || ''));
}

export async function renameStage({ db, scope, input }) {
  const { stageId, name, expectedVersion: version } = input.body;
  const current = await db.execute({
    sql: 'SELECT pipeline_id, name FROM crm_pipeline_stages WHERE id = ? AND school_id = ? AND archived_at IS NULL',
    args: [stageId, scope.schoolId],
  });
  const stage = current.rows[0];
  if (!stage) throw crmErrors.notFound();

  const now = new Date().toISOString();
  let results;
  try {
    results = await db.batch([
      {
        sql: `UPDATE crm_pipeline_stages SET name = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND school_id = ? AND version = ? AND archived_at IS NULL`,
        args: [name, now, stageId, scope.schoolId, version],
      },
      auditStatement(scope, {
        action: 'pipeline.changed',
        entityId: stage.pipeline_id,
        summary: { change: 'stage_renamed', stageId, fromName: stage.name, toName: name },
        onlyIfChanged: true,
        now,
      }),
    ], 'write');
  } catch (error) {
    if (isUniqueNameViolation(error)) throw new CrmHttpError(422, 'duplicate_name', 'Another stage already has this name');
    throw error;
  }
  await assertVersionedWrite(results, 0, async () => {
    const row = await db.execute({ sql: 'SELECT version FROM crm_pipeline_stages WHERE id = ? AND school_id = ? AND archived_at IS NULL', args: [stageId, scope.schoolId] });
    return row.rows[0]?.version ?? null;
  });
  return loadPipeline(db, scope.schoolId, stage.pipeline_id);
}

/**
 * Reorders every active stage of the default pipeline in one guarded batch:
 * positions change only if the pipeline is still at `expectedVersion`, and the
 * pipeline version is bumped in the same transaction.
 */
export async function reorderStages({ db, scope, input }) {
  const { stageIds, expectedVersion: version } = input.body;
  const pipelineId = await ensureDefaultPipeline(db, scope.schoolId);
  const current = await loadPipeline(db, scope.schoolId, pipelineId);
  const known = new Set(current.stages.map((stage) => stage.id));
  if (stageIds.length !== known.size || new Set(stageIds).size !== stageIds.length || !stageIds.every((stageId) => known.has(stageId))) {
    throw crmErrors.validation([{ path: 'stageIds', message: 'Send every active stage exactly once' }]);
  }

  const now = new Date().toISOString();
  const cases = stageIds.map(() => 'WHEN ? THEN ?').join(' ');
  const results = await db.batch([
    {
      sql: `UPDATE crm_pipeline_stages SET position = CASE id ${cases} END, updated_at = ?
            WHERE pipeline_id = ? AND school_id = ? AND archived_at IS NULL
              AND (SELECT version FROM crm_pipelines WHERE id = ? AND school_id = ?) = ?`,
      args: [...stageIds.flatMap((stageId, position) => [stageId, position]), now, pipelineId, scope.schoolId, pipelineId, scope.schoolId, version],
    },
    {
      sql: 'UPDATE crm_pipelines SET version = version + 1, updated_at = ? WHERE id = ? AND school_id = ? AND version = ?',
      args: [now, pipelineId, scope.schoolId, version],
    },
    auditStatement(scope, { action: 'pipeline.changed', entityId: pipelineId, summary: { change: 'stages_reordered' }, onlyIfChanged: true, now }),
  ], 'write');
  await assertVersionedWrite(results, 1, async () => {
    const row = await db.execute({ sql: 'SELECT version FROM crm_pipelines WHERE id = ? AND school_id = ? AND archived_at IS NULL', args: [pipelineId, scope.schoolId] });
    return row.rows[0]?.version ?? null;
  });
  return loadPipeline(db, scope.schoolId, pipelineId);
}

async function pipelineVersion(db, scope, pipelineId) {
  const row = await db.execute({ sql: 'SELECT version FROM crm_pipelines WHERE id = ? AND school_id = ? AND archived_at IS NULL', args: [pipelineId, scope.schoolId] });
  return row.rows[0]?.version ?? null;
}

function bumpPipeline(scope, pipelineId, version, now) {
  return {
    sql: 'UPDATE crm_pipelines SET version = version + 1, updated_at = ? WHERE id = ? AND school_id = ? AND version = ?',
    args: [now, pipelineId, scope.schoolId, version],
  };
}

/**
 * Adds an open or applicant stage after the last stage of its category (D6).
 * Guarded by the pipeline version; later stages shift down by one.
 */
export async function addStage({ db, scope, input }) {
  const { name, category, expectedVersion: version } = input.body;
  if (!ADDABLE_CATEGORIES.includes(category)) throw crmErrors.validation([{ path: 'category', message: 'Only lead or applicant stages can be added' }]);
  const pipelineId = await ensureDefaultPipeline(db, scope.schoolId);
  const current = await loadPipeline(db, scope.schoolId, pipelineId);
  const sameCategory = current.stages.filter((stage) => stage.category === category);
  const after = sameCategory.length ? sameCategory[sameCategory.length - 1].position : Math.max(-1, ...current.stages.filter((stage) => stage.category === 'open').map((stage) => stage.position));
  const position = after + 1;
  const now = new Date().toISOString();
  const stageId = `${pipelineId}_s_${crypto.randomUUID().slice(0, 8)}`;
  let results;
  try {
    results = await db.batch([
      bumpPipeline(scope, pipelineId, version, now),
      {
        sql: `UPDATE crm_pipeline_stages SET position = position + 1, updated_at = ?
              WHERE pipeline_id = ? AND school_id = ? AND archived_at IS NULL AND position >= ? AND changes() > 0`,
        args: [now, pipelineId, scope.schoolId, position],
      },
      {
        sql: `INSERT INTO crm_pipeline_stages (id, school_id, pipeline_id, stage_key, name, category, position, version, created_at, updated_at)
              SELECT ?, ?, ?, NULL, ?, ?, ?, 1, ?, ? WHERE (SELECT version FROM crm_pipelines WHERE id = ?) = ?`,
        args: [stageId, scope.schoolId, pipelineId, name, category, position, now, now, pipelineId, version + 1],
      },
      auditStatement(scope, { action: 'pipeline.changed', entityId: pipelineId, summary: { change: 'stage_added', stageId, toName: name, category }, onlyIfChanged: true, now }),
    ], 'write');
  } catch (error) {
    if (isUniqueNameViolation(error)) throw new CrmHttpError(422, 'duplicate_name', 'Another stage already has this name');
    throw error;
  }
  await assertVersionedWrite(results, 0, () => pipelineVersion(db, scope, pipelineId));
  return loadPipeline(db, scope.schoolId, pipelineId);
}

/**
 * Archives an open or applicant stage (D6). Its leads move to the chosen
 * destination, each with a stage event, in the same guarded batch. The last
 * open stage can't be archived: new leads need somewhere to land.
 */
export async function archiveStage({ db, scope, input }) {
  const { stageId, destinationStageId, expectedVersion: version } = input.body;
  const pipelineId = await ensureDefaultPipeline(db, scope.schoolId);
  const current = await loadPipeline(db, scope.schoolId, pipelineId);
  const stage = current.stages.find((item) => item.id === stageId);
  if (!stage) throw crmErrors.notFound();
  if (!ADDABLE_CATEGORIES.includes(stage.category)) {
    throw new CrmHttpError(422, 'stage_locked', 'The Enrolled and Lost stages can be renamed but not archived');
  }
  if (stage.category === 'open' && current.stages.filter((item) => item.category === 'open').length === 1) {
    throw new CrmHttpError(422, 'last_open_stage', 'Keep at least one lead stage: new leads start there');
  }
  let destination = null;
  if (stage.leadCount > 0) {
    destination = current.stages.find((item) => item.id === destinationStageId && item.id !== stageId);
    if (!destination || !ADDABLE_CATEGORIES.includes(destination.category)) {
      throw crmErrors.validation([{ path: 'destinationStageId', message: `Choose where the ${stage.leadCount} lead(s) in this stage should go` }]);
    }
    assertTransition('leadStage', stage.category, destination.category);
  }
  const now = new Date().toISOString();
  const reason = `Stage archived: ${stage.name}`;
  const statements = [bumpPipeline(scope, pipelineId, version, now)];
  if (destination) {
    statements.push(
      {
        sql: `INSERT INTO crm_lead_stage_events (id, school_id, lead_id, from_stage_id, to_stage_id, actor_user_id, reason, created_at)
              SELECT 'lse_' || lower(hex(randomblob(16))), school_id, id, stage_id, ?, ?, ?, ?
              FROM crm_leads WHERE stage_id = ? AND school_id = ? AND archived_at IS NULL
                AND (SELECT version FROM crm_pipelines WHERE id = ?) = ?`,
        args: [destination.id, scope.actor.user_id || null, reason, now, stageId, scope.schoolId, pipelineId, version + 1],
      },
      {
        sql: `UPDATE crm_leads SET stage_id = ?, version = version + 1, last_activity_at = ?, updated_at = ?
              WHERE stage_id = ? AND school_id = ? AND archived_at IS NULL
                AND (SELECT version FROM crm_pipelines WHERE id = ?) = ?`,
        args: [destination.id, now, now, stageId, scope.schoolId, pipelineId, version + 1],
      },
    );
  }
  statements.push(
    {
      sql: `UPDATE crm_pipeline_stages SET archived_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND archived_at IS NULL AND (SELECT version FROM crm_pipelines WHERE id = ?) = ?`,
      args: [now, now, stageId, scope.schoolId, pipelineId, version + 1],
    },
    auditStatement(scope, {
      action: 'pipeline.changed',
      entityId: pipelineId,
      summary: { change: 'stage_archived', stageId, fromName: stage.name, ...(destination ? { destinationStageId: destination.id, movedLeads: stage.leadCount } : {}) },
      onlyIfChanged: true,
      now,
    }),
  );
  const results = await db.batch(statements, 'write');
  await assertVersionedWrite(results, 0, () => pipelineVersion(db, scope, pipelineId));
  return loadPipeline(db, scope.schoolId, pipelineId);
}

export async function updateRequirements({ db, scope, input }) {
  const { requirements, expectedVersion: version } = input.body;
  const pipelineId = await ensureDefaultPipeline(db, scope.schoolId);
  const now = new Date().toISOString();
  const results = await db.batch([
    {
      sql: 'UPDATE crm_pipelines SET requirements_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND school_id = ? AND version = ?',
      args: [JSON.stringify(requirements), now, pipelineId, scope.schoolId, version],
    },
    auditStatement(scope, {
      action: 'pipeline.changed',
      entityId: pipelineId,
      summary: { change: 'requirements_changed', requirements: REQUIREMENT_KEYS.filter((key) => requirements[key]) },
      onlyIfChanged: true,
      now,
    }),
  ], 'write');
  await assertVersionedWrite(results, 0, () => pipelineVersion(db, scope, pipelineId));
  return loadPipeline(db, scope.schoolId, pipelineId);
}
