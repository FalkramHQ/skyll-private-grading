import { randomUUID } from 'node:crypto';
import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { resolveSchoolId } from '../../api/_lib/canonicalSubmissions.js';
import { buildClassDnaAggregate } from '../../api/_lib/classDna.js';
import { buildStudentContext } from '../../api/_lib/contextBuilder.js';
import { seesUnreleasedResults } from '../../api/_lib/studentRelease.js';
import { checkRateLimit } from '../../api/_lib/rateLimit.js';
import { handleCors } from '../../api/_lib/cors.js';
import { isSchoolFeatureEnabled } from '../../api/_lib/featureFlags.js';
import { internalError } from '../../api/_lib/httpError.js';

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

async function resolveTargetUsername(user, req) {
  const queryUsername = String(req.query?.username || req.query?.student || '').trim();
  const body = parseBody(req);
  const bodyUsername = String(body.username || body.student || '').trim();
  const requested = queryUsername || bodyUsername || user.username;
  const staff = ['teacher', 'admin', 'skyll_admin'].includes(user.role);
  if (requested !== user.username && !staff) {
    return { error: { status: 403, message: 'You do not have permission to view this hive' } };
  }
  return { username: requested };
}

async function schoolIdForUser(db, user) {
  if (user.school_id) return user.school_id;
  if (!user.school) return null;
  return resolveSchoolId(db, user.school);
}

/** GET /api/ai/hive — signals + DNA + synthesis history (school-scoped). */
export async function getHive(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['student', 'teacher', 'admin', 'skyll_admin']);
    if (!user) return;

    if (await checkRateLimit(`hive:${user.user_id || user.username}`, { max: 30, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }

    const target = await resolveTargetUsername(user, req);
    if (target.error) return res.status(target.error.status).json({ error: target.error.message });

    const db = database();
    const schoolId = await schoolIdForUser(db, user);
    if (!schoolId && user.role !== 'skyll_admin') {
      return res.status(403).json({ error: 'School access denied' });
    }

    // Only platform admins may browse another school; everyone else is pinned
    // to their own (FLKRM-382).
    const scopedSchoolId = user.role === 'skyll_admin' ? String(req.query?.schoolId || schoolId || '').trim() : schoolId;
    if (!scopedSchoolId) return res.status(400).json({ error: 'schoolId is required' });

    const self = target.username === user.username;
    const context = await buildStudentContext(db, {
      schoolId: scopedSchoolId,
      username: target.username,
      userId: self ? user.user_id : undefined,
      selfUsername: self ? user.username : undefined,
      includeUnreleased: seesUnreleasedResults(user),
    });

    // A student outside the scoped school is indistinguishable from a missing one.
    if (!context.resolved || (!context.studentId && !context.dna && !context.signals.length)) {
      return res.status(404).json({ error: 'Hive data not found for this student' });
    }

    const deepSignals = await isSchoolFeatureEnabled(
      { ...user, school_id: scopedSchoolId },
      'deep_signals',
    );

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({
      student: {
        id: context.studentId || null,
        username: context.username || target.username,
        name: context.name,
        className: context.className,
        school: context.school,
      },
      schoolId: scopedSchoolId,
      dna: context.dna,
      dnaMeta: {
        examCount: context.examCount,
        questionCount: context.questionCount,
        updatedAt: context.dnaUpdatedAt,
      },
      signals: context.signals,
      synthesisRuns: context.synthesisRuns,
      recentReports: context.recentReports,
      features: { deep_signals: deepSignals },
    });
  } catch (error) {
    return internalError(res, error, 'ai/hive');
  }
}

/** POST /api/ai/hive/synthesize — teacher/admin enqueue only. */
export async function postHiveSynthesize(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['teacher', 'admin', 'skyll_admin']);
    if (!user) return;

    if (await checkRateLimit(`hive-synth:${user.user_id || user.username}`, { max: 10, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }

    const body = parseBody(req);
    const username = String(body.username || body.student || req.query?.username || '').trim();
    const studentIdArg = String(body.studentId || '').trim();
    if (!username && !studentIdArg) {
      return res.status(400).json({ error: 'username or studentId is required' });
    }

    const db = database();
    const schoolId = await schoolIdForUser(db, user);
    if (!schoolId && user.role !== 'skyll_admin') {
      return res.status(403).json({ error: 'School access denied' });
    }
    const scopedSchoolId = user.role === 'skyll_admin' ? String(body.schoolId || schoolId || '').trim() : schoolId;
    if (!scopedSchoolId) return res.status(400).json({ error: 'schoolId is required' });

    const deepSignals = await isSchoolFeatureEnabled(
      { ...user, school_id: scopedSchoolId },
      'deep_signals',
    );
    if (!deepSignals && user.role !== 'skyll_admin') {
      return res.status(403).json({ error: 'Deep signals are not enabled for this school' });
    }

    const context = await buildStudentContext(db, {
      schoolId: scopedSchoolId,
      username: username || undefined,
      studentId: studentIdArg || undefined,
      includeUnreleased: seesUnreleasedResults(user),
    });
    if (!context.resolved || !context.studentId) {
      return res.status(404).json({ error: 'Student not found in this school' });
    }

    const anchor = (await db.execute({
      sql: `SELECT es.submission_id, ts.test_id, sc.display_name AS school
            FROM evidence_signals es
            JOIN test_submissions ts ON ts.id = es.submission_id
            JOIN schools sc ON sc.id = es.school_id
            WHERE es.school_id = ? AND es.student_id = ? AND es.status = 'active'
            ORDER BY es.extracted_at DESC
            LIMIT 1`,
      args: [scopedSchoolId, context.studentId],
    }).catch(() => ({ rows: [] }))).rows[0];

    if (!anchor?.test_id) {
      return res.status(409).json({
        error: 'No evidence signals found to synthesize. Run deep-signal extraction first.',
      });
    }

    const now = new Date().toISOString();
    const jobId = `job_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await db.execute({
      sql: `INSERT INTO processing_jobs (
              id, test_id, school, type, status, payload_json, requested_by, requested_at, progress_json
            ) VALUES (?, ?, ?, 'hive_synthesis', 'queued', ?, ?, ?, ?)`,
      args: [
        jobId,
        anchor.test_id,
        anchor.school || context.school || user.school,
        JSON.stringify({
          studentId: context.studentId,
          username: context.username || username || null,
          schoolId: scopedSchoolId,
          triggerSource: 'teacher_api',
        }),
        user.username,
        now,
        JSON.stringify({
          steps: {
            synthesize_dna: {
              status: 'queued',
              detail: 'Teacher-triggered Hive DNA synthesis',
            },
          },
        }),
      ],
    });

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(202).json({
      ok: true,
      jobId,
      studentId: context.studentId,
      username: context.username || username || null,
      message: 'Hive synthesis queued',
    });
  } catch (error) {
    return internalError(res, error, 'ai/hive/synthesize');
  }
}

/** GET /api/ai/hive/class — simplified class-level mode heatmap. */
export async function getHiveClass(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['teacher', 'admin', 'skyll_admin']);
    if (!user) return;

    if (await checkRateLimit(`hive-class:${user.user_id || user.username}`, { max: 30, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }

    const db = database();
    const schoolId = await schoolIdForUser(db, user);
    const scopedSchoolId = String(req.query?.schoolId || schoolId || '').trim();
    if (!scopedSchoolId) return res.status(400).json({ error: 'schoolId is required' });
    if (user.role !== 'skyll_admin' && scopedSchoolId !== schoolId) {
      return res.status(403).json({ error: 'School access denied' });
    }

    const classFilter = String(req.query?.class || req.query?.cls || '').trim();
    const args = [scopedSchoolId];
    let classJoin = '';
    let classClause = '';
    if (classFilter) {
      classJoin = `JOIN student_enrollments enrollment ON enrollment.student_id = dna.student_id AND enrollment.status = 'active'
                   JOIN academic_years year ON year.id = enrollment.academic_year_id AND year.school_id = dna.school_id AND year.is_current = 1`;
      classClause = ' AND enrollment.standard = ?';
      args.push(classFilter);
    }

    const modeRows = (await db.execute({
      sql: `SELECT json_extract(dna.dna_json, '$.primary_mode.mode_id') AS mode_id, COUNT(*) AS student_count
            FROM learner_dna_v2 dna
            ${classJoin}
            WHERE dna.school_id = ?${classClause}
              AND json_extract(dna.dna_json, '$.primary_mode.mode_id') IS NOT NULL
              AND TRIM(json_extract(dna.dna_json, '$.primary_mode.mode_id')) != ''
            GROUP BY mode_id
            ORDER BY student_count DESC`,
      args,
    }).catch(() => ({ rows: [] }))).rows;

    const edgeRows = (await db.execute({
      sql: `SELECT json_extract(dna.dna_json, '$.growth_edge.mode_id') AS mode_id, COUNT(*) AS student_count
            FROM learner_dna_v2 dna
            ${classJoin}
            WHERE dna.school_id = ?${classClause}
              AND json_extract(dna.dna_json, '$.growth_edge.mode_id') IS NOT NULL
              AND TRIM(json_extract(dna.dna_json, '$.growth_edge.mode_id')) != ''
            GROUP BY mode_id
            ORDER BY student_count DESC`,
      args,
    }).catch(() => ({ rows: [] }))).rows;

    const sampleArgs = [...args, 12];
    const samples = (await db.execute({
      sql: `SELECT dna.student_id,
                   st.display_name,
                   (SELECT uc.login_id FROM student_user_links sul
                    JOIN user_credentials uc ON uc.user_id = sul.user_id
                    WHERE sul.student_id = dna.student_id AND uc.status = 'active'
                    ORDER BY uc.is_primary DESC LIMIT 1) AS username,
                   json_extract(dna.dna_json, '$.primary_mode.mode_id') AS primary_mode,
                   json_extract(dna.dna_json, '$.growth_edge.mode_id') AS growth_edge,
                   dna.updated_at
            FROM learner_dna_v2 dna
            JOIN students st ON st.id = dna.student_id
            ${classJoin}
            WHERE dna.school_id = ?${classClause}
            ORDER BY dna.updated_at DESC
            LIMIT ?`,
      args: sampleArgs,
    }).catch(() => ({ rows: [] }))).rows;

    const signalCount = (await db.execute({
      sql: `SELECT COUNT(*) AS n FROM evidence_signals WHERE school_id = ? AND status = 'active'`,
      args: [scopedSchoolId],
    }).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.n || 0;

    const profileCount = (await db.execute({
      sql: `SELECT COUNT(*) AS n
            FROM learner_dna_v2 dna
            ${classJoin}
            WHERE dna.school_id = ?${classClause}`,
      args,
    }).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.n || 0;

    const dnaJsonRows = (await db.execute({
      sql: `SELECT dna.dna_json
            FROM learner_dna_v2 dna
            ${classJoin}
            WHERE dna.school_id = ?${classClause}
            ORDER BY dna.updated_at DESC
            LIMIT 200`,
      args,
    }).catch(() => ({ rows: [] }))).rows;

    const dnaProfiles = dnaJsonRows.map((row) => parseJson(row.dna_json, null)).filter(Boolean);
    const classDna = buildClassDnaAggregate({
      primaryModes: modeRows.map((row) => ({
        modeId: row.mode_id,
        count: Number(row.student_count) || 0,
      })),
      growthEdges: edgeRows.map((row) => ({
        modeId: row.mode_id,
        count: Number(row.student_count) || 0,
      })),
      dnaProfiles,
      profileCount,
      signalCount,
      classFilter: classFilter || null,
    });

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({
      schoolId: scopedSchoolId,
      classFilter: classFilter || null,
      primaryModes: classDna.primaryModes,
      growthEdges: classDna.growthEdges,
      mastery: classDna.mastery,
      students: samples.map((row) => ({
        studentId: row.student_id,
        name: row.display_name,
        username: row.username,
        primaryMode: row.primary_mode,
        growthEdge: row.growth_edge,
        updatedAt: row.updated_at,
      })),
      totals: {
        dnaProfiles: classDna.totals.dnaProfiles,
        activeSignals: classDna.totals.activeSignals,
        topicsTracked: classDna.totals.topicsTracked,
      },
    });
  } catch (error) {
    return internalError(res, error, 'ai/hive/class');
  }
}

export default getHive;
