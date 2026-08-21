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
import { connect, loadTemplate, readWeek, saveAndVerify, loadShifts, loadOpenShifts, locateStation, claimShift, checkClaim, SHIFT_BLOCKS } from './tmwork.mjs';
import { buildCalendar } from './calendar.mjs';
import { syncCalendar } from './calendar-sync.mjs';
import { createMadMax } from './madmax.mjs';
import { notify } from './notify.mjs';

const PORT = Number(process.env.PORT ?? 8123);
const HOST = '127.0.0.1';
const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));

// Sign-in costs seconds, so hold it briefly. Short enough that a server-side
// expiry means one slow request, not a wedged UI.
const SESSION_TTL_MS = 5 * 60 * 1000;
let cached = null;

async function getSession() {
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached.session;
  const session = await connect(config);
  cached = { session, at: Date.now() };
  return session;
}

// Signing in is four sequential requests: /signin, the POST, /emp/, then the
// token scrape. That is a second or more, and a lazy session meant it landed in
// front of whichever sweep happened to cross the TTL, delaying both the
// detection and the claim on that sweep. Rotating an ageing session after a
// sweep instead pays the cost in the idle gap. Only while armed, so an unused
// server is not signing in on a timer.
async function rotateSessionIfAgeing() {
  if (!cached || Date.now() - cached.at < SESSION_TTL_MS * 0.8) return;
  try {
    cached = { session: await connect(config), at: Date.now() };
  } catch {
    // Better to make the next caller sign in than to hold a broken session.
    cached = null;
  }
}

// Only an expired session is worth retrying. Retrying anything else doubles the
// request, and against the swap lockout the retry is actively harmful: the board
// needs 30 minutes with nothing asking, so the second call restarts the clock
// the first one started. That put the breaker below a retry that defeated it.
const looksExpired = (err) => /\b401\b|invalid token|APP\.Token/i.test(err.message);

async function withSession(fn) {
  try {
    return await fn(await getSession());
  } catch (err) {
    if (!looksExpired(err)) throw err;
    cached = null;
    return fn(await getSession());
  }
}

// A subscribed calendar polls this, and every rebuild costs several TeamWork
// calls, so the result is held briefly and shared with the UI.
const SHIFTS_TTL_MS = 5 * 60 * 1000;
let shiftCache = null;

const withPlace = (shift) => ({ ...shift, ...locateStation(shift.station, config.maps) });

async function refreshShifts() {
  const { shifts, all } = await withSession((s) => loadShifts(s));
  const data = { shifts: shifts.map(withPlace), all: all.map(withPlace) };
  shiftCache = { data, at: Date.now() };

  // Push into Calendar whenever the schedule is re-read, which is what makes
  // this automatic. Never let a Calendar failure break serving shifts.
  if (config.calendar?.autoSync) {
    syncCalendar(data.all, config.calendar)
      .then(({ synced }) => console.log(`calendar: synced ${synced} shifts`))
      .catch((err) => console.error('calendar sync failed,', err.message));
  }

  return data;
}

// Cold, this costs a sign-in plus a request per week, which is far longer than
// a calendar client will wait. `allowStale` hands back the last copy and
// refreshes behind the scenes so the feed always answers immediately.
async function getShifts({ allowStale = false } = {}) {
  if (shiftCache && Date.now() - shiftCache.at < SHIFTS_TTL_MS) return shiftCache.data;

  if (allowStale && shiftCache) {
    refreshShifts().catch((err) => console.error('shift refresh failed,', err.message));
    return shiftCache.data;
  }

  return refreshShifts();
}

// Armed state lives here and nowhere else, so restarting the server disarms it.
const madmax = createMadMax({
  config: config.madmax ?? {},
  intervalMs: (config.madmax?.intervalSeconds ?? 45) * 1000,
  loadBoard: () => boardShifts(),
  loadMine: async () => (await getShifts({ allowStale: true })).all,
  claim: (shift) => withSession((s) => claimShift(s, shift)),
  check: (shift) => withSession((s) => checkClaim(s, shift)),
  afterSweep: rotateSessionIfAgeing,
  onEvent: (event) => {
    console.log(`madmax: ${event.kind}${event.station ? ` ${event.station}` : ''}${event.why ? ` (${event.why})` : ''}`);
    appendJsonl(MADMAX_LOG, event);

    const when = event.start ? new Date(event.start).toLocaleString(undefined, {
      weekday: 'short', hour: 'numeric', minute: '2-digit',
    }) : '';

    if (event.kind === 'claimed') {
      notify('Shift claimed', `${event.station ?? 'Shift'} · ${when}`, { sound: 'Glass' });
    }

    // A shift was on the board and the claim did not land. Somebody else got
    // there first, or the server refused it, and the reason is in the event.
    if (event.kind === 'failed') {
      notify('Claim failed', `${event.station ?? 'Shift'} · ${when}: ${event.why ?? 'unknown'}`, { sound: 'Sosumi' });
    }

    if (event.kind === 'checked') {
      notify('Claim check (nothing taken)', `${event.station ?? 'Shift'} · ${when}: ${event.why ?? ''}`, { sound: 'Ping' });
    }
  },
});

// TeamWork revokes board access with "Swap list disabled. (30) minutes idle
// required for reset." Because any request restarts that 30 minutes, one shared
// breaker has to hold every caller off, not just the one that tripped it.
const SWAP_COOLDOWN_MS = 31 * 60 * 1000;
let swapBlockedUntil = 0;

async function boardShifts() {
  if (Date.now() < swapBlockedUntil) {
    const until = new Date(swapBlockedUntil).toLocaleTimeString();
    throw new Error(`swap list locked out, resting until ${until}`);
  }

  try {
    const open = await withSession((s) => loadOpenShifts(s));
    // Every board read feeds the log, not just the ones the UI asks for. This
    // used to hang off the /api/open-shifts route, so the frequent reads (Mad
    // Max sweeping) recorded nothing and the log stayed almost empty.
    await noteBoardChange(open);
    return open;
  } catch (err) {
    if (/disabled|idle required/i.test(err.message)) {
      swapBlockedUntil = Date.now() + SWAP_COOLDOWN_MS;
      madmax.disarm();
      notify('Swap list locked out', 'TeamWork disabled the board. Resting 31 minutes.', { sound: 'Sosumi' });
      console.error('swapboard locked out, resting 31 min');
    }
    throw err;
  }
}

// JSONL because appending a line cannot corrupt the ones before it.
const logPath = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const HISTORY = logPath('history.jsonl');
const MADMAX_LOG = logPath('madmax-log.jsonl');

// Logs are a nicety. Never fail real work because one could not be written.
async function appendJsonl(file, entry) {
  try {
    await appendFile(file, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error(`log append failed (${file}):`, err.message);
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

// Logged only on change, so it answers "when do shifts appear" rather than
// filling with a line a minute saying nothing happened.
const BOARD_LOG = logPath('board-log.jsonl');
let lastBoardSignature = null;

// How long a shift survives on the board is the one number that decides whether
// there is a race worth entering, and nothing was measuring it. Holding the
// first sighting per id gives it directly on the way out.
const firstSeen = new Map();

async function noteBoardChange(shifts) {
  const signature = shifts.map((s) => s.id).sort().join(',');
  if (signature === lastBoardSignature) return;

  const previous = lastBoardSignature;
  lastBoardSignature = signature;

  const now = Date.now();
  const present = new Set(shifts.map((s) => s.id));
  const events = [];

  for (const shift of shifts) {
    if (firstSeen.has(shift.id)) continue;
    firstSeen.set(shift.id, now);
    events.push({
      kind: 'appeared', shift: shift.id, station: shift.station,
      start: shift.start, hours: shift.hours, mode: shift.mode,
      // On the first look after a restart we are seeing the board, not a
      // change, so the lifetime that follows is a floor and not a measurement.
      ...(previous === null ? { sinceRestart: true } : {}),
    });
  }

  for (const [id, seenAt] of firstSeen) {
    if (present.has(id)) continue;
    firstSeen.delete(id);
    // Taken by somebody, by me, or pulled by a manager. Which one is unknown
    // here, but the survival time is what the interval argument needs.
    events.push({ kind: 'gone', shift: id, livedSeconds: Math.round((now - seenAt) / 1000) });
  }

  for (const event of events) await appendJsonl(BOARD_LOG, { at: new Date().toISOString(), ...event });
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
  // normalize() collapses ../ before the join, so requests cannot escape public/.
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
        weeklyHourCap: config.weeklyHourCap ?? null,
        pay: config.pay ?? null,
        shiftBlocks: SHIFT_BLOCKS,
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
        await appendJsonl(HISTORY, {
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
      return sendJson(res, 200, await getShifts());
    }

    if (pathname === '/api/open-shifts' && req.method === 'GET') {
      const open = await boardShifts();
      return sendJson(res, 200, {
        shifts: open.map(withPlace),
        checkedAt: new Date().toISOString(),
      });
    }

    // Availability is wiped weekly, so "what I had last time" is the common want.
    if (pathname === '/api/last-week' && req.method === 'GET') {
      const [previous] = await readHistory(1);
      return sendJson(res, 200, { week: previous?.week ?? null, at: previous?.at ?? null });
    }

    if (pathname === '/api/history' && req.method === 'GET') {
      return sendJson(res, 200, { history: await readHistory() });
    }

    if (pathname === '/api/madmax' && req.method === 'GET') {
      return sendJson(res, 200, { ...madmax.state, rules: config.madmax ?? {} });
    }

    if (pathname === '/api/madmax' && req.method === 'POST') {
      const { armed } = await readBody(req);
      const state = armed ? madmax.arm() : madmax.disarm();
      return sendJson(res, 200, { ...state, rules: config.madmax ?? {} });
    }

    if (pathname === '/api/calendar/sync' && req.method === 'POST') {
      const { all } = await getShifts();
      const result = await syncCalendar(all, config.calendar);
      return sendJson(res, 200, { ...result, calendar: config.calendar?.name });
    }

    // Kept as a manual fallback and for any client that can read a file.
    if (pathname === '/calendar.ics') {
      const { all } = await getShifts({ allowStale: true });
      res.writeHead(200, {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': 'attachment; filename="rso-shifts.ics"',
        'cache-control': 'no-cache',
      });
      return res.end(buildCalendar(all, { name: `${config.template} shifts` }));
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'no such endpoint' });

    return serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RSO availability UI  ->  http://${HOST}:${PORT}`);
  // Warm the cache so the first calendar poll never waits on a cold sign-in.
  refreshShifts().catch((err) => console.error('warm-up failed,', err.message));
});
