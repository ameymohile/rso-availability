// Local web UI for the RSO availability tool.
//
//   node server.mjs      then open http://127.0.0.1:8123
//
// Binds to loopback only. This can change your real availability, so it should
// never be reachable from the network.

import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, loadTemplate, readWeek, saveAndVerify, loadShifts, loadOpenShifts, loadSwapCounts, locateStation, claimShift, checkClaim, SHIFT_BLOCKS } from './tmwork.mjs';
import { buildCalendar } from './calendar.mjs';
import { syncCalendar } from './calendar-sync.mjs';
import { createMadMax } from './madmax.mjs';
import { notify } from './notify.mjs';
import { createMailWatch } from './mailwatch.mjs';
import { createBudget } from './budget.mjs';
import { createDetector } from './detect.mjs';
import { createHeartbeat } from './heartbeat.mjs';
import { createAwake } from './awake.mjs';
import { keychainPassword } from './tmwork.mjs';

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
let lastSyncedSchedule = null;

const withPlace = (shift) => ({ ...shift, ...locateStation(shift.station, config.maps) });

async function refreshShifts() {
  // The board reaches ~84 days out. Reading only 4 weeks of my own schedule left
  // the cap and overlap rules blind past that, so they silently passed on
  // anything further out. 13 weeks covers the board. This is the calendar
  // endpoint, not the throttled swap one.
  const { shifts, all } = await withSession((s) => loadShifts(s, { weeks: 13 }));
  const data = { shifts: shifts.map(withPlace), all: all.map(withPlace) };
  shiftCache = { data, at: Date.now() };

  // Only when the schedule actually changed. A sync deletes and recreates every
  // RSO event, and this used to fire on every re-read: four times during a
  // single boot, which on a phone subscribed to that calendar is four rounds of
  // alerts for shifts that did not move.
  const signature = data.all.map((s) => `${s.id}@${s.start}-${s.end}`).sort().join('|');
  if (config.calendar?.autoSync && signature !== lastSyncedSchedule) {
    lastSyncedSchedule = signature;
    syncCalendar(data.all, config.calendar)
      .then(({ synced }) => console.log(`calendar: synced ${synced} shifts`))
      .catch((err) => {
        // Let the next refresh try again rather than staying quiet until a change.
        lastSyncedSchedule = null;
        console.error('calendar sync failed,', err.message);
      });
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

// Held only while armed. See awake.mjs: this stops idle sleep, which is what was
// making an ARMED panel meaningless, but it cannot stop lid-close sleep.
const awake = createAwake({
  onEvent: (event) => {
    console.log(`awake: ${event.kind}${event.why ? ` (${event.why})` : ''}`);
    if (event.kind === 'awake-lost') {
      madmax.note({ kind: 'error', why: 'lost the wake assertion, the machine can sleep again' });
    }
  },
});

// Armed state lives here and nowhere else, so restarting the server disarms it.
const madmax = createMadMax({
  config: config.madmax ?? {},
  intervalMs: (config.madmax?.intervalSeconds ?? 45) * 1000,
  loadBoard: (cause, hint) => boardShifts(cause === 'poll' ? 'routine' : 'urgent', hint?.anchors),
  loadMine: async () => (await getShifts({ allowStale: true })).all,
  claim: async (shift) => {
    const result = await swapWrite((s) => claimShift(s, shift));
    // What I hold just changed, so the 5 minute cache is wrong now. Leaving it
    // meant the next sweep planned against a schedule missing the shift it had
    // just taken, and claimed straight through the weekly cap.
    shiftCache = null;
    return result;
  },
  check: (shift) => swapWrite((s) => checkClaim(s, shift)),
  afterSweep: rotateSessionIfAgeing,
  onArmChange: (armed) => {
    // The detector costs requests, so it runs only while the bot is armed. It is
    // also the fast lane, so it starts before the first sweep rather than after.
    if (armed) {
      awake.hold();
      detector.start();
    } else {
      awake.release();
      detector.stop();
    }
  },
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

// Push, not polling. A shift that lives a second is invisible to any safe poll
// rate, so the interval becomes a safety net and this becomes the fast path.
const mailWatch = createMailWatch({
  config: config.mail ?? {},
  password: config.mail?.user
    ? keychainPassword(config.mail.user, { optional: true, envVar: 'TMWORK_MAIL_PASSWORD' })
    : null,
  onTrigger: (reason) => madmax.trigger(reason),
  onEvent: (event) => {
    if (event.kind === 'mail-status') return;
    console.log(`mail: ${event.kind}${event.subject ? ` ${event.subject}` : ''}${event.why ? ` (${event.why})` : ''}`);
    // Kept even when it does not trigger. If a shift is posted and no mail
    // arrives, this file is the evidence that email is not the route.
    appendJsonl(MAIL_LOG, { at: new Date().toISOString(), ...event });
  },
});

// Detection, moved off the endpoint that bans you. swapboardCounts covers ~84
// days in one request and answered four calls at every spacing down to 200ms
// without a refusal (probe.mjs --floor, 2026-08-21), where the board endpoint
// refuses inside 1.5s. So this carries the frequency and the board endpoint is
// touched only when a count actually moves.
//
// Its own budget, because it is a different endpoint with a different limiter.
//
// The rate is set by what has actually been demonstrated, not by the floor. The
// floor probe found no spacing counts refuses, down to 200ms, and yet 125
// consecutive calls at 1.01/s were every one of them refused on 2026-08-21. Both
// are true: four calls in a row cannot find a ceiling counted over minutes. What
// the probe did demonstrate is 42 requests over ~90s, about 27/min, with no
// refusal. So the ceiling here is 26/min and the interval sits just under it.
//
// `probe.mjs --run --sustain=counts` is what would raise this honestly. It holds
// a rate for a minute at a time and stops at the first refusal, so the last rate
// it completes is the real number. Until then, 24/min is the evidence.
const countsBudget = createBudget({
  spacingMs: 2000,
  routinePerMinute: 26,
  perMinute: 30,
  per10Minutes: 260,
  ...(config.madmax?.countsBudget ?? {}),
  onRest: ({ until, why, ms }) => {
    madmax.note({ kind: 'rest', why: `counts lane: ${why}, silent until ${new Date(until).toLocaleTimeString()}` });
    console.warn(`counts lane resting ${Math.round(ms / 60000)} min: ${why}`);

    // A lockout arrives through whichever endpoint happened to ask, and it
    // applies to the whole swap subsystem. The lane that hears it silences the
    // other, because a board read during the rest restarts TeamWork's 30 minute
    // idle clock just as surely as a counts read would.
    if (ms >= 30 * 60_000) boardBudget.rest(ms, `${why} (heard on the counts lane)`);
  },
});

const detector = createDetector({
  intervalMs: (config.madmax?.detectIntervalSeconds ?? 2.5) * 1000,
  budget: countsBudget,
  loadCounts: () => withSession((s) => loadSwapCounts(s)),
  onPosting: ({ anchors, why, urgent }) => {
    // The changed day names the month, so the board read that follows is one
    // aimed request rather than a guess at where to look.
    madmax.trigger(`counts: ${why}`, { anchors });
    if (urgent) notify('Shift posted', why, { sound: 'Ping' });
  },
  onEvent: (event) => {
    if (event.kind === 'detector-status') return;
    console.log(`detect: ${event.kind}${event.why ? ` (${event.why})` : ''}`);
    appendJsonl(BOARD_LOG, { at: new Date().toISOString(), ...event });
  },
});

// Closing the lid suspends this process instead of killing it, so launchd sees
// nothing wrong and never restarts it, and on wake the sweep resumes as if
// nothing happened. Saying so out loud matters more than it sounds: a panel
// reading "swept just now" after a night asleep claims coverage that never
// existed, and the decision to trust the bot depends on knowing the difference.
let lastGap = null;

const heartbeat = createHeartbeat({
  onGap: (gapMs) => {
    const minutes = Math.round(gapMs / 60000);
    lastGap = { at: new Date().toISOString(), minutes };

    madmax.note({ kind: 'gap', why: `not running for ~${minutes} min (lid closed or asleep). Shifts posted then were missed.` });
    console.warn(`heartbeat: ${minutes} min gap, process was suspended`);

    // The socket did not survive the suspend even though it may still look open,
    // so rebuild it now rather than waiting out its timeout with the fast path
    // quietly dead.
    mailWatch.reconnect('woke after a gap');
  },
});

const LOCKOUT_FILE = fileURLToPath(new URL('./.swap-lockout', import.meta.url));

// Held on disk, not just in memory. launchd runs this with KeepAlive, so a crash
// five minutes into the rest used to come back with a clean breaker and start
// poking the board again during the one window where silence is the whole point.
const restoredRest = (() => {
  try {
    const until = Number(readFileSync(LOCKOUT_FILE, 'utf8').trim());
    if (Number.isFinite(until) && until > Date.now()) {
      console.warn(`swapboard still resting until ${new Date(until).toLocaleTimeString()}`);
      return until;
    }
  } catch { /* no lockout on record */ }
  return 0;
})();

// The single owner of how often the swapboard endpoint may be asked anything.
// See budget.mjs for why this is a budget and not just a spacing gate: the
// lockout on 2026-08-21 happened because a plain 400 "Please wait [1.5] seconds"
// was logged as an error and changed nothing about the next request.
//
// The defaults are deliberately slower than the 5s sweep that earned that
// lockout. 2500ms of spacing is well clear of the declared 1500, and the routine
// ceiling of 8/min leaves 4 for reads that a posting actually triggered, so an
// empty board can never spend the allowance that the one interesting moment
// needs. Override in config.json under madmax.budget.
const boardBudget = createBudget({
  spacingMs: 2500,
  routinePerMinute: 8,
  perMinute: 12,
  per10Minutes: 60,
  ...(config.madmax?.budget ?? {}),
  restoreRestUntil: restoredRest,
  onRest: ({ until, why, ms }) => {
    try {
      writeFileSync(LOCKOUT_FILE, String(until));
    } catch (writeErr) {
      console.error('could not persist the rest:', writeErr.message);
    }

    const minutes = Math.round(ms / 60000);
    madmax.note({ kind: 'rest', why: `${why}, silent until ${new Date(until).toLocaleTimeString()}` });
    console.warn(`swapboard resting ${minutes} min: ${why}`);

    // A short backoff needs no user action, because the budget itself refuses
    // reads until it expires. A real lockout does: arming again during it would
    // restart TeamWork's 30 minute idle clock every time it tried.
    if (ms >= 30 * 60_000) {
      madmax.disarm();
      notify('Swap list locked out', `TeamWork cut off the board. Resting ${minutes} min.`, { sound: 'Sosumi' });
    }
  },
});

const restingError = () => {
  const rest = boardBudget.resting;
  return new Error(rest
    ? `${rest.why}, ${Math.ceil(rest.waitMs / 1000)}s left`
    : 'swapboard resting');
};

// The last board actually read, so a caller the budget turns away can be given
// something true and dated rather than an error.
let lastBoard = { shifts: [], at: null };

// `kind` decides which allowance this read spends. A tick of the clock is
// routine and must leave room behind it; a counts change, a mail trigger or a
// manual refresh is urgent, because something outside the timer thinks the board
// just changed and that is the read worth having.
//
// `anchors` narrows it. A read the counts lane asked for already knows which
// months moved, so it costs one aimed request instead of the blind rotation.
async function boardShifts(kind = 'routine', anchors) {
  const open = await withSession(
    (s) => loadOpenShifts(s, { via: (fn) => boardBudget.run(fn, { kind }), anchors }),
  );
  lastBoard = { shifts: open, at: new Date().toISOString() };
  // Every board read feeds the log, not just the ones the UI asks for. This used
  // to hang off the /api/open-shifts route, so the frequent reads (Mad Max
  // sweeping) recorded nothing and the log stayed almost empty.
  await noteBoardChange(open);
  return open;
}

// Claims deliberately do not spend the board's allowance. The refusal we have
// actually seen is "Please wait [1.5] seconds to refresh *list*", so the limiter
// looks like it belongs to the read, and a claim held back by our own accounting
// is the one request that must never be late.
//
// They do report refusals, though. A lockout can arrive through the claim path
// as easily as the read path, and it used to be swallowed inside Promise.all
// while the sweep carried on writing at a board that had already cut us off.
async function swapWrite(fn) {
  if (boardBudget.resting) throw restingError();

  try {
    return await withSession(fn);
  } catch (err) {
    boardBudget.report(err.message);
    throw err;
  }
}

// JSONL because appending a line cannot corrupt the ones before it.
const logPath = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const HISTORY = logPath('history.jsonl');
const MADMAX_LOG = logPath('madmax-log.jsonl');
const MAIL_LOG = logPath('mail-log.jsonl');

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

// Loopback is not access control. Any page you visit can make your own browser
// POST here, and a form with enctype="text/plain" needs no preflight, so a
// drive-by site could arm the bot or rewrite your real availability. Same-origin
// requests from the UI send Origin or no Origin at all; a cross-site form sends
// somebody else's.
const ALLOWED_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

const originAllowed = (req) => {
  const origin = req.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin);
};

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);

  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
    console.warn(`rejected ${req.method} ${pathname} from origin ${req.headers.origin}`);
    return sendJson(res, 403, { error: 'cross-origin requests are not allowed' });
  }

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
      try {
        const open = await boardShifts();
        return sendJson(res, 200, {
          shifts: open.map(withPlace),
          checkedAt: new Date().toISOString(),
          budget: boardBudget.state,
        });
      } catch (err) {
        // Having the page open must not be able to spend the allowance the bot
        // is holding for a posting, and must not surface as an error either. The
        // last board we actually read is the honest answer, labelled with when.
        if (!err.budgetDenied) throw err;
        return sendJson(res, 200, {
          shifts: lastBoard.shifts.map(withPlace),
          checkedAt: lastBoard.at,
          held: err.message,
          budget: boardBudget.state,
        });
      }
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
      return sendJson(res, 200, {
        ...madmax.state,
        rules: config.madmax ?? {},
        mail: mailWatch.status,
        lastGap,
        awake: awake.held,
        // What is left to spend, so "why has it not swept" has an answer on the
        // panel instead of only in the log.
        budget: boardBudget.state,
        counts: { ...countsBudget.state, detector: detector.status },
      });
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

  // Watching costs nothing at TeamWork, so it runs whether or not Mad Max is
  // armed: the log then answers "does a posted shift even generate mail" long
  // before anyone needs the trigger to work.
  mailWatch.start();
  const mail = mailWatch.status;
  console.log(mail.configured
    ? `mail watch: ${config.mail.user} via ${config.mail.host}`
    : 'mail watch: not configured (see config.example.json "mail")');

  heartbeat.start();
});

// A watcher holding an IMAP socket would otherwise keep the process alive.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    awake.release();
    mailWatch.stop().finally(() => process.exit(0));
  });
}
