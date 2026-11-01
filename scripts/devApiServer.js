import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import http from 'node:http';
import { URL } from 'node:url';
import loginHandler from '../server/auth/login.js';
import sessionHandler from '../server/auth/session.js';
import teacherDashboardHandler from '../api/teacher-dashboard.js';
import queryHandler from '../api/query.js';
import authCatchAll from '../api/auth/[...route].js';

function adaptRes(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify(data));
    return res;
  };
  res.send = (data) => {
    res.end(data);
    return res;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  adaptRes(res);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  // Webhook signatures are checked against the exact bytes received.
  req.rawBody = Buffer.concat(chunks);
  const body = req.rawBody.toString('utf8');
  try {
    req.body = body ? JSON.parse(body) : {};
  } catch {
    req.body = {};
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:3456'}`);
  req.query = Object.fromEntries(parsedUrl.searchParams.entries());

  const pathname = parsedUrl.pathname;
  console.log(`[API DEV] ${req.method} ${pathname}`);

  try {
    if (pathname === '/api/auth/login' || pathname === '/api/auth/login/') {
      return await loginHandler(req, res);
    }
    if (pathname === '/api/auth/session' || pathname === '/api/auth/session/') {
      return await sessionHandler(req, res);
    }
    if (pathname === '/api/teacher-dashboard') {
      return await teacherDashboardHandler(req, res);
    }
    if (pathname === '/api/query') {
      return await queryHandler(req, res);
    }
    if (pathname === '/api/vl-queue') {
      const vlQueueHandler = (await import('../api/vl-queue.js')).default;
      return await vlQueueHandler(req, res);
    }
    if (pathname === '/api/student-answer-sheet') {
      const studentAnswerSheetHandler = (await import('../api/student-answer-sheet.js')).default;
      return await studentAnswerSheetHandler(req, res);
    }
    if (pathname === '/api/student-context') {
      const studentContextHandler = (await import('../api/student-context.js')).default;
      return await studentContextHandler(req, res);
    }
    if (pathname.startsWith('/api/rechecks')) {
      const routeStr = pathname.replace(/^\/api\/rechecks\/?/, '');
      req.query.route = routeStr ? routeStr.split('/') : undefined;
      const rechecksHandler = (await import('../api/rechecks/[[...route]].js')).default;
      return await rechecksHandler(req, res);
    }
    if (pathname.startsWith('/api/auth/')) {
      const routeParts = pathname.replace('/api/auth/', '').split('/').filter(Boolean);
      req.query.route = routeParts;
      return await authCatchAll(req, res);
    }

    res.status(404).json({ error: `Local dev endpoint not found: ${pathname}` });
  } catch (err) {
    console.error('[API DEV ERROR]', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

server.listen(3456, '127.0.0.1', () => {
  console.log('🚀 Local Skyll API Server running on http://127.0.0.1:3456');
});
