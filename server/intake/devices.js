import { ensureAuthTables, requireUser, database } from '../../api/_lib/auth.js';
import { ensureIntakeTables } from '../../api/_lib/intake.js';
import { INTAKE_SCANNER_ROLES, isIntakeManager } from './rolePolicy.js';
import { internalError } from '../../api/_lib/httpError.js';

const DEVICE_TELEMETRY_ROLES = [...INTAKE_SCANNER_ROLES, 'student'];

export default async function handler(req, res) {
  try {
    await ensureAuthTables(); await ensureIntakeTables();
    const db = database();
    if (req.method === 'GET') {
      const user = await requireUser(req, res, INTAKE_SCANNER_ROLES);
      if (!user) return;
      if (!isIntakeManager(user)) return res.status(403).json({ error: 'Device status is available only to school administrators.' });
      const result = await db.execute({
        sql: `SELECT installation_id, username, platform, app_version, runtime_version, update_id, last_seen_at
              FROM intake_installations WHERE school = ? ORDER BY last_seen_at DESC LIMIT 200`,
        args: [user.school],
      });
      return res.status(200).json({ installations: result.rows });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const user = await requireUser(req, res, DEVICE_TELEMETRY_ROLES);
    if (!user) return;
    const { installationId, platform, appVersion, runtimeVersion, updateId, expoPushToken } = req.body || {};
    if (!installationId || String(installationId).length > 128) return res.status(400).json({ error: 'A valid installation ID is required' });
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO intake_installations (installation_id, school, username, role, platform, app_version, runtime_version, update_id, expo_push_token, last_seen_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(installation_id) DO UPDATE SET school = excluded.school, username = excluded.username,
              role = excluded.role, platform = excluded.platform, app_version = excluded.app_version, runtime_version = excluded.runtime_version,
              update_id = excluded.update_id, last_seen_at = excluded.last_seen_at,
              -- A device that changes hands keeps no push token from the
              -- previous account, so nobody can redirect another's alerts.
              expo_push_token = CASE
                WHEN intake_installations.username = excluded.username AND intake_installations.school = excluded.school
                  THEN COALESCE(excluded.expo_push_token, intake_installations.expo_push_token)
                ELSE excluded.expo_push_token
              END`,
      args: [String(installationId), user.school, user.username, String(user.role || '').slice(0, 32), String(platform || 'unknown').slice(0, 32), String(appVersion || '').slice(0, 64), String(runtimeVersion || '').slice(0, 64), String(updateId || '').slice(0, 128), expoPushToken ? String(expoPushToken).slice(0, 256) : null, now, now],
    });
    return res.status(200).json({ ok: true, seenAt: now });
  } catch (error) { return internalError(res, error, 'intake-devices'); }
}
