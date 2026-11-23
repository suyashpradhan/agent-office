// HTTP layer: a small JSON API, a Server-Sent Events stream, and the static dashboard.
// No framework on purpose, so the whole request path stays visible.
//
//   GET  /api/state                 full snapshot (on page load)
//   GET  /api/events                live event stream (SSE)
//   POST /api/tasks                 { title, brief, stages?, review? }
//   GET  /api/tasks/:id             task + runs + handoff documents + activity
//   POST /api/tasks/:id/approve
//   POST /api/tasks/:id/changes     { feedback }
//   POST /api/tasks/:id/retry
//   POST /api/tasks/:id/cancel
//   GET  /api/tasks/:id/files/:name a deliverable file (e.g. the designer's mockup)
//   POST /api/tasks/:id/blockers    { blockerId }: this task waits for that one
//   POST /api/tasks/:id/blockers/:blockerId/remove
//   POST /api/tasks/:id/accept      start a proposed sub-task
//   POST /api/tasks/:id/dismiss     turn a proposed sub-task down
//   POST /api/tasks/:id/accept-subtasks   accept all of a task's pending proposals
//   GET  /api/routines              scheduled tasks
//   POST /api/routines              { name, title, brief, stages, review, schedule }
//   POST /api/routines/:id          update, e.g. { enabled: false }
//   POST /api/routines/:id/run      create its task right now
//   POST /api/routines/:id/remove
//   GET  /api/schedule/preview?cron=0+9+*+*+1-5   plain English + next 3 runs
//   GET  /api/agents/:id
//   POST /api/agents/:id/stop
//   POST /api/office/pause | /api/office/resume

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createServer({ orch, bus }) {
  const routes = [
    ['GET', /^\/api\/state$/, () => orch.snapshot()],
    ['POST', /^\/api\/tasks$/, (_, body) => orch.createTask(body)],
    ['GET', /^\/api\/tasks\/(\d+)$/, ([id]) => orch.taskDetail(id)],
    ['POST', /^\/api\/tasks\/(\d+)\/approve$/, ([id]) => orch.approve(id)],
    ['POST', /^\/api\/tasks\/(\d+)\/changes$/, ([id], body) => orch.requestChanges(id, body.feedback)],
    ['POST', /^\/api\/tasks\/(\d+)\/retry$/, ([id]) => orch.retry(id)],
    ['POST', /^\/api\/tasks\/(\d+)\/cancel$/, ([id]) => orch.cancel(id)],
    ['POST', /^\/api\/tasks\/(\d+)\/blockers$/, ([id], body) => orch.addBlocker(id, body.blockerId)],
    ['POST', /^\/api\/tasks\/(\d+)\/blockers\/(\d+)\/remove$/, ([id, blockerId]) => orch.removeBlocker(id, blockerId)],
    ['POST', /^\/api\/tasks\/(\d+)\/accept$/, ([id]) => orch.acceptSubtask(id)],
    ['POST', /^\/api\/tasks\/(\d+)\/dismiss$/, ([id]) => orch.dismissSubtask(id)],
    ['POST', /^\/api\/tasks\/(\d+)\/accept-subtasks$/, ([id]) => orch.acceptAllSubtasks(id)],
    ['GET', /^\/api\/agents\/([\w-]+)$/, ([id]) => orch.agentDetail(id)],
    ['POST', /^\/api\/agents\/([\w-]+)\/stop$/, ([id]) => orch.stopAgent(id)],
    ['GET', /^\/api\/routines$/, () => orch.listRoutines()],
    ['POST', /^\/api\/routines$/, (_, body) => orch.createRoutine(body)],
    ['POST', /^\/api\/routines\/(\d+)$/, ([id], body) => orch.updateRoutine(id, body)],
    ['POST', /^\/api\/routines\/(\d+)\/run$/, ([id]) => orch.runRoutineNow(id)],
    ['POST', /^\/api\/routines\/(\d+)\/remove$/, ([id]) => orch.removeRoutine(id)],
    ['GET', /^\/api\/schedule\/preview$/, (_, __, url) => orch.schedulePreview(url.searchParams.get('cron'))],
    ['POST', /^\/api\/office\/pause$/, () => orch.setPaused(true)],
    ['POST', /^\/api\/office\/resume$/, () => orch.setPaused(false)],
  ];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/events') return sse(req, res, bus, orch);

      const file = url.pathname.match(/^\/api\/tasks\/(\d+)\/files\/([\w.-]+)$/);
      if (file && req.method === 'GET') {
        // Agent-written HTML is untrusted: serve it sandboxed so it can't call this API.
        res.writeHead(200, {
          'Content-Type': file[2].endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
          'Content-Security-Policy': 'sandbox',
        });
        return res.end(fs.readFileSync(orch.taskFile(file[1], file[2])));
      }

      if (url.pathname.startsWith('/api/')) {
        for (const [method, pattern, handler] of routes) {
          const m = url.pathname.match(pattern);
          if (m && req.method === method) {
            const body = method === 'POST' ? await readJson(req) : {};
            return json(res, 200, (await handler(m.slice(1), body, url)) ?? { ok: true });
          }
        }
        return json(res, 404, { error: 'Not found' });
      }

      return serveStatic(url.pathname, res);
    } catch (err) {
      if (!err.status) console.error(err);
      json(res, err.status || 500, { error: err.message });
    }
  });
}

function sse(req, res, bus, orch) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: 'snapshot', state: orch.snapshot() });
  const unsubscribe = bus.subscribe(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(Object.assign(new Error('Body too large'), { status: 413 }));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
  });
}
