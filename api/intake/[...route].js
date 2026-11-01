import batches from '../../server/intake/batches.js';
import devices from '../../server/intake/devices.js';
import jobs from '../../server/intake/jobs.js';
import tests from '../../server/intake/tests.js';
import uploads from '../../server/intake/uploads.js';
import { handleCors } from '../_lib/cors.js';

const handlers = { batches, devices, jobs, tests, uploads };

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  const segment = Array.isArray(req.query?.route)
    ? req.query.route[0]
    : req.query?.route || new URL(req.url, 'https://skyllai.local').pathname.split('/').filter(Boolean).at(-1);
  const route = String(segment || '');
  const selected = handlers[route];
  if (!selected) return res.status(404).json({ error: 'Intake endpoint not found' });
  return selected(req, res);
}
