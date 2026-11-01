import { database } from '../../api/_lib/auth.js';

export const SCHOOL_SLUG_ALIASES = {
  partnerc: 'Partner Academy C',
  partnera: "Partner Academy A",
  partnerd: 'Partner Academy D',
  partnere: 'Partner Academy E',
  partnerf: 'Partner Academy F',
  partnerb: "Partner Academy B",
  individual: 'Skyll Individual',
};

export function slugifySchoolName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

let slugColumnReady = false;

export async function ensureSchoolSlugColumn() {
  if (slugColumnReady) return;
  const db = database();
  const info = await db.execute('PRAGMA table_info(schools)').catch(() => ({ rows: [] }));
  const columns = new Set((info.rows || []).map((row) => row.name));
  if (!columns.has('slug')) {
    await db.execute('ALTER TABLE schools ADD COLUMN slug TEXT');
  }
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS schools_slug_idx ON schools (slug) WHERE slug IS NOT NULL');
  slugColumnReady = true;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { slug } = req.query;
  if (!slug || typeof slug !== 'string') {
    return res.status(400).json({ error: 'Missing slug parameter' });
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug format' });
  }

  try {
    await ensureSchoolSlugColumn();
    const db = database();
    const bySlug = await db.execute({
      sql: "SELECT id, slug, display_name FROM schools WHERE slug = ? AND status = 'active' LIMIT 1",
      args: [slug],
    });
    if (bySlug.rows.length) {
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(200).json(bySlug.rows[0]);
    }

    const aliasName = SCHOOL_SLUG_ALIASES[slug];
    const schools = await db.execute({
      sql: "SELECT id, slug, display_name FROM schools WHERE status = 'active'",
    });
    const match = schools.rows.find((row) => {
      if (aliasName && row.display_name === aliasName) return true;
      return slugifySchoolName(row.display_name) === slug;
    });
    if (!match) {
      return res.status(404).json({ error: 'School not found' });
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ ...match, slug: match.slug || slug });
  } catch (err) {
    console.error('School lookup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
