// Local web UI for the RSO availability tool.
//
//   node server.mjs      then open http://127.0.0.1:8123
//
// Binds to loopback only. This can change your real availability, so it should
// never be reachable from the network.

import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, loadTemplate, readWeek, saveAndVerify, loadShifts, loadOpenShifts } from './tmwork.mjs';

const PORT = Number(process.env.PORT ?? 8123);
const HOST = '127.0.0.1';
const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));

// Signing in costs a couple of seconds, so hold the session briefly rather than
// repeating it on every click. Short enough that a server-side expiry just
// means one slow request, not a wedged UI.
const SESSION_TTL_MS = 5 * 60 * 1000;
let cached = null;

async function getSession() {
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached.session;
  const session = await connect(config);
  cached = { session, at: Date.now() };
  return session;
}

// Any API failure may just be an expired session, so drop it and try once more
// with a fresh sign-in before surfacing the error.
async function withSession(fn) {
  try {
    return await fn(await getSession());
  } catch (err) {
    cached = null;
    return fn(await getSession());
  }
}

// Append-only log of what was actually saved, so "when did I change this?" has
// an answer later. JSONL because appending a line cannot corrupt earlier ones.
const HISTORY = fileURLToPath(new URL('./history.jsonl', import.meta.url));

async function appendHistory(entry) {
  try {
    await appendFile(HISTORY, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    // History is a nicety. Never fail a save because the log could not be
    // written.
    console.error('history: could not append,', err.message);
  }
}

async function readHistory(limit = 20) {
  try {
    const text = await readFile(HISTORY, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}

// Records the board only when it CHANGES, so the log answers "when do shifts
// actually appear?" instead of filling up with a line a minute saying nothing
// happened. Settles the "Friday, I think" question with evidence.
const BOARD_LOG = fileURLToPath(new URL('./board-log.jsonl', import.meta.url));
let lastBoardSignature = null;

async function noteBoardChange(shifts) {
  const signature = shifts.map((s) => s.id).sort().join(',');
  if (signature === lastBoardSignature) return;

  const previous = lastBoardSignature;
  lastBoardSignature = signature;
  // Skip the very first observation after a restart: we cannot tell a real
  // change from simply not having looked before.
  if (previous === null) return;

  try {
    await appendFile(BOARD_LOG, `${JSON.stringify({
      at: new Date().toISOString(),
      count: shifts.length,
      shifts: shifts.map((s) => ({ id: s.id, start: s.start, station: s.station, hours: s.hours })),
    })}\n`);
  } catch (err) {
    console.error('board log: could not append,', err.message);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

async function serveStatic(req, res, pathname) {
  // normalize() collapses any ../ before we join, so requests cannot escape
  // the public directory.
  const rel = normalize(pathname === '/' ? 'index.html' : pathname.slice(1));
  if (rel.startsWith('..')) return sendJson(res, 403, { error: 'forbidden' });

  try {
    const file = await readFile(join(ROOT, rel));
    res.writeHead(200, {
      'content-type': MIME[extname(rel)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);

  try {
    if (pathname === '/api/week' && req.method === 'GET') {
      const { meta, template } = await withSession((s) => loadTemplate(s, config));
      return sendJson(res, 200, {
        template: meta.Title,
        week: readWeek(template),
        at: new Date().toISOString(),
      });
    }

    if (pathname === '/api/week' && req.method === 'POST') {
      const { week } = await readBody(req);
      if (!week || typeof week !== 'object') {
        return sendJson(res, 400, { error: 'expected a "week" object' });
      }

      const result = await withSession((session) => saveAndVerify(session, config, week));

      if (result.saved) {
        await appendHistory({
          at: new Date().toISOString(),
          changes: result.changes,
          week: result.week,
          verified: result.mismatches.length === 0,
        });
      }

      return sendJson(res, 200, {
        template: result.meta.Title,
        week: result.week,
        changes: result.changes,
        saved: result.saved,
        verified: result.mismatches.length === 0,
        mismatches: result.mismatches,
        at: new Date().toISOString(),
      });
    }

    if (pathname === '/api/shifts' && req.method === 'GET') {
      const shifts = await withSession((s) => loadShifts(s));
      return sendJson(res, 200, { shifts });
    }

    if (pathname === '/api/open-shifts' && req.method === 'GET') {
      const result = await withSession((s) => loadOpenShifts(s));
      await noteBoardChange(result.shifts);
      return sendJson(res, 200, { ...result, checkedAt: new Date().toISOString() });
    }

    if (pathname === '/api/history' && req.method === 'GET') {
      return sendJson(res, 200, { history: await readHistory() });
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'no such endpoint' });

    return serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RSO availability UI  ->  http://${HOST}:${PORT}`);
});
