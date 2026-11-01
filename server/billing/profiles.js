import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { internalError } from '../../api/_lib/httpError.js';
import {
  INDIAN_STATES,
  isBillingProfileComplete,
  presentBillingProfile,
  validateBillingProfile,
} from '../../api/_lib/billingProfiles.js';
import { getAllPricingBands, getPricingBands, replaceBandsStatements, validateBands } from '../../api/_lib/pricing.js';

/**
 * School billing profiles (FLKRM-485), folded into the auth catch-all
 * (12-function cap). skyll_admin only; schools never see or edit these.
 *
 *   GET /api/auth/billing-profiles  every school with its profile (or null),
 *                                   whether it is complete, and the list of
 *                                   valid places of supply.
 *   PUT /api/auth/billing-profiles  { schoolId, legalName, address, gstin?,
 *                                   pan?, placeOfSupply, bands? } → create or
 *                                   update. `bands` ([{ maxMarks, pricePaise }],
 *                                   #311) replaces the school's price bands when
 *                                   present; [] means the default ₹0.25/mark.
 *
 * There is no delete: a school with no graded papers gets no invoice anyway,
 * and issued invoices carry their own snapshot of the profile.
 */
export default async function billingProfiles(req, res) {
  if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['skyll_admin']);
    if (!user) return;
    const db = database();
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method === 'GET') {
      const result = await db.execute(`SELECT s.id, s.slug, s.display_name, s.status, p.*
        FROM schools s LEFT JOIN school_billing_profiles p ON p.school_id = s.id
        ORDER BY s.display_name COLLATE NOCASE`);
      const bandsBySchool = await getAllPricingBands(db);
      const schools = result.rows.map((row) => {
        const profile = presentBillingProfile(row.school_id ? row : null);
        return { id: row.id, slug: row.slug, name: row.display_name, status: row.status, profile, complete: isBillingProfileComplete(profile), bands: bandsBySchool.get(row.id) || [] };
      });
      return res.status(200).json({ schools, states: INDIAN_STATES });
    }

    const schoolId = String(req.body?.schoolId || '').trim();
    if (!schoolId) return res.status(400).json({ error: 'schoolId is required.' });
    const { profile, error } = validateBillingProfile(req.body);
    if (error) return res.status(400).json({ error });
    const replaceBands = Object.prototype.hasOwnProperty.call(req.body || {}, 'bands');
    const { bands, error: bandsError } = replaceBands ? validateBands(req.body.bands) : { bands: null };
    if (bandsError) return res.status(400).json({ error: bandsError });
    const school = await db.execute({ sql: 'SELECT id FROM schools WHERE id = ? LIMIT 1', args: [schoolId] });
    if (!school.rows.length) return res.status(404).json({ error: 'School not found.' });
    const now = new Date().toISOString();
    const updatedBy = user.username || user.user_id || 'skyll_admin';
    // Profile and bands save together or not at all.
    await db.batch([
      {
        sql: `INSERT INTO school_billing_profiles (school_id, legal_name, address, gstin, pan, place_of_supply, updated_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(school_id) DO UPDATE SET
                legal_name = excluded.legal_name, address = excluded.address, gstin = excluded.gstin, pan = excluded.pan,
                place_of_supply = excluded.place_of_supply, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        args: [schoolId, profile.legalName, profile.address, profile.gstin, profile.pan, profile.placeOfSupply, updatedBy, now, now],
      },
      ...(replaceBands ? replaceBandsStatements(schoolId, bands, { updatedBy, now }) : []),
    ], 'write');
    const saved = await db.execute({ sql: 'SELECT * FROM school_billing_profiles WHERE school_id = ? LIMIT 1', args: [schoolId] });
    const presented = presentBillingProfile(saved.rows[0]);
    return res.status(200).json({ profile: presented, complete: isBillingProfileComplete(presented), bands: await getPricingBands(db, schoolId) });
  } catch (error) {
    return internalError(res, error, 'billing-profiles');
  }
}
