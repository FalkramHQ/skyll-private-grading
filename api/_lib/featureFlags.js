import { database } from './auth.js';

export const SCHOOL_FEATURES = ['review_scale_v2', 'review_focus_layout', 'mobile_portal_v2', 'deep_signals', 'crm'];

export async function schoolFeaturesForActor(actor) {
  // Platform staff must be able to verify a guarded rollout before enabling it
  // for a partner school. Their bypass is not persisted as a school setting.
  if (actor?.role === 'skyll_admin') {
    return Object.fromEntries(SCHOOL_FEATURES.map((feature) => [feature, true]));
  }
  if (!actor?.school_id) return Object.fromEntries(SCHOOL_FEATURES.map((feature) => [feature, false]));
  const result = await database().execute({
    sql: `SELECT feature_key, enabled FROM school_feature_flags
          WHERE school_id = ? AND feature_key IN (${SCHOOL_FEATURES.map(() => '?').join(', ')})`,
    args: [actor.school_id, ...SCHOOL_FEATURES],
  }).catch(() => ({ rows: [] }));
  const enabled = new Set(result.rows.filter((row) => Number(row.enabled) === 1).map((row) => row.feature_key));
  return Object.fromEntries(SCHOOL_FEATURES.map((feature) => [feature, enabled.has(feature)]));
}

export async function isSchoolFeatureEnabled(actor, feature) {
  return Boolean((await schoolFeaturesForActor(actor))[feature]);
}
