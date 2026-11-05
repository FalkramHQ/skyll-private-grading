import health from '../../server/ai/health.js';
import { getHive, getHiveClass, postHiveSynthesize } from '../../server/ai/hive.js';
import tutor from '../../server/ai/tutor.js';
import revision from '../../server/ai/revision.js';
import readiness from '../../server/ai/readiness.js';
import { getMastery } from '../../server/ai/mastery.js';
import practice from '../../server/ai/practice.js';
import {
  briefing,
  getArtifacts,
  getCoverage,
  getWarnings,
  postCopilot,
  postIntervention,
  postLessonPlan,
  postParentReport,
  postQuizGen,
} from '../../server/ai/teacher.js';
import { handleCors } from '../_lib/cors.js';
import { withRequestInferenceContext } from '../_lib/privateInferenceRequest.js';

const handlers = {
  health,
  hive: getHive,
  // Vercel only matches one path segment under /api/ai/[...route], so nested
  // paths like hive/class never reach this function (platform 404).
  'hive-synthesize': postHiveSynthesize,
  'hive-class': getHiveClass,
  'hive/synthesize': postHiveSynthesize,
  'hive/class': getHiveClass,
  tutor,
  revision,
  readiness,
  mastery: getMastery,
  practice,
  copilot: postCopilot,
  'lesson-plan': postLessonPlan,
  'quiz-gen': postQuizGen,
  briefing,
  intervention: postIntervention,
  warnings: getWarnings,
  coverage: getCoverage,
  artifacts: getArtifacts,
  'parent-report': postParentReport,
};

function routeKey(req) {
  const fromQuery = req.query?.route;
  if (Array.isArray(fromQuery) && fromQuery.length) {
    return fromQuery.map(String).filter(Boolean).join('/');
  }
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const parts = new URL(req.url, 'https://skyllai.local').pathname.split('/').filter(Boolean);
  // /api/ai/<...>
  const aiIndex = parts.indexOf('ai');
  if (aiIndex >= 0 && parts.length > aiIndex + 1) {
    return parts.slice(aiIndex + 1).join('/');
  }
  return parts.at(-1) || '';
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  const route = routeKey(req);
  const selected = handlers[route];
  if (!selected) {
    return res.status(404).json({
      error: 'AI endpoint not found',
      supportedRoutes: Object.keys(handlers),
    });
  }
  return withRequestInferenceContext(req, `ai:${route}`, () => selected(req, res));
}
