// TeamWork (tmwork.net) client, shared by the CLI and the local server.
// API notes and how it was worked out: NOTES.md.

import { execFileSync } from 'node:child_process';
import { send } from './http.mjs';

const BASE = 'https://www.tmwork.net';
const KEYCHAIN_SERVICE = 'tmwork-rso';

// TeamWork numbers days 1..7 from Sunday.
export const DAY_ORDER = [
  'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday',
];

// The five RSO shift blocks, as minutes past midnight. M sorts first because it
// starts at midnight, so a full set collapses to 0-1440, which is all day.
export const SHIFT_BLOCKS = [
  { code: 'A', from: 480, to: 720 },
  { code: 'B', from: 720, to: 960 },
  { code: 'C1', from: 960, to: 1200 },
  { code: 'C2', from: 1200, to: 1440 },
  { code: 'M', from: 0, to: 480 },
];

const pad = (n) => String(n).padStart(2, '0');

// 480 -> "8am", 1440 -> "12am". Matches the string TeamWork writes itself.
export function minutesToLabel(minutes) {
  const total = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(total / 60);
  const mins = total % 60;
  const suffix = hour < 12 ? 'am' : 'pm';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return mins ? `${hour12}:${pad(mins)}${suffix}` : `${hour12}${suffix}`;
}

// TeamWork dates its slots to whatever day the form was rendered on, even for a
// Sunday row, so the date carries no meaning and only the minutes matter.
function slotIso(minutes) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

// Merges touching ranges so A+B becomes one 8am-4pm block rather than two.
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [];

  for (const [from, to] of sorted) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }

  return merged;
}

// Ranges the day is available for. 'off' and 'all-day' stay as strings because
// they are what TeamWork itself stores: disabled, or enabled with no slots.
export const rangesFor = (value) => (Array.isArray(value) ? mergeRanges(value) : []);

// Local YYYY-MM-DD. toISOString() would shift an evening shift to the next day.
export const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const startOfWeek = (from) => {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
};

function getPassword(account) {
  try {
    return execFileSync('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w',
    ], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'No Keychain entry found. Store it once with:\n'
      + `  security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${account} -w`,
    );
  }
}

// One session is one cookie jar plus one API token, kept per instance so the
// server can hold several without them treading on each other.
function createSession(config) {
  const jar = new Map();
  let apiToken = null;

  function storeCookies(res) {
    for (const line of res.setCookie ?? []) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  // Every reply carries whether it inherited a warm socket, so "the claim did
  // not pay for a handshake" stays a measurement rather than a belief.
  let lastReusedSocket = null;

  async function request(url, options = {}, hops = 0) {
    if (hops > 5) throw new Error(`Too many redirects: ${url}`);

    const res = await send(url, {
      method: options.method ?? 'GET',
      body: options.body == null ? null : String(options.body),
      headers: {
        cookie: cookieHeader(),
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        // node:https does not decompress for us the way fetch did, and http.mjs
        // only handles what it can prove it can read.
        'accept-encoding': 'gzip, identity',
        // /api/ rejects cookies alone with "Invalid Token". Both are required.
        ...(apiToken && url.includes('/api/') ? { 'x-api-token': apiToken } : {}),
        ...options.headers,
      },
    });
    storeCookies(res);
    lastReusedSocket = res.reusedSocket;

    const location = res.status >= 300 && res.status < 400 && res.location;
    // Redirects after a POST are followed as GET, per normal browser rules.
    return location
      ? request(new URL(location, url).href, { headers: options.headers }, hops + 1)
      : res;
  }

  async function signIn(password) {
    const page = await request(`${BASE}/signin`);
    const antiforgery = page.body
      .match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1];
    if (!antiforgery) throw new Error('Could not find the antiforgery token on /signin');

    await request(`${BASE}/SignIn?handler=EmpLogin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: `${BASE}/signin`,
      },
      body: new URLSearchParams({
        portal: 'emp',
        EmpCode: config.employeeCode,
        EmpUser: config.employeeUser,
        EmpPassword: password,
        __RequestVerificationToken: antiforgery,
      }).toString(),
    });

    // A bad password re-renders the form instead of erroring, so a missing
    // APP.Token is how a silent failure shows up.
    const shell = await request(`${BASE}/emp/`);
    apiToken = shell.body.match(/APP\.Token\s*=\s*'([^']+)'/)?.[1] ?? null;
    if (!apiToken) {
      throw new Error('Signed in but found no APP.Token in /emp/. The Keychain password is probably wrong.');
    }
  }

  async function getJson(path) {
    const res = await request(`${BASE}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      // The body carries the reason, e.g. the "Please wait [1.5] seconds"
      // throttle. Dropping it made rate limits look like generic failures.
      //
      // Some refusals carry no body at all: swapboardCounts answers 400 with
      // nothing in it, which is what made 125 refusals in a row at 03:23 on
      // 2026-08-21 indistinguishable from a bug. The status is now always in the
      // message so budget.mjs can treat a silent 4xx as the refusal it is.
      const detail = res.body.slice(0, 200).trim();
      throw new Error(`GET ${path} -> ${res.status}${detail ? ` ${detail}` : ' (empty body)'}`);
    }
    return JSON.parse(res.body);
  }

  async function putJson(path, payload) {
    const res = await request(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`PUT ${path} -> ${res.status} ${res.body}`);
    return res;
  }

  // Everything a probe needs and nothing a caller should rely on: the status
  // instead of an exception, the body as text, the header set left open so the
  // browser's exact request can be reproduced, and the wall clock around the
  // call. getJson throws on a refusal and drops the timing, which is the two
  // things a rate-limit measurement is made of.
  async function getRaw(path, { headers = {} } = {}) {
    const at = Date.now();
    try {
      const res = await request(`${BASE}${path}`, { headers });
      return {
        status: res.status, ok: res.ok, ms: res.ms, body: res.body, reusedSocket: res.reusedSocket,
      };
    } catch (err) {
      // A transport failure is a data point too, and it must not stop a sweep
      // through the remaining spacings.
      return { status: 0, ok: false, ms: Date.now() - at, body: err.message, reusedSocket: false };
    }
  }

  return {
    signIn,
    getJson,
    putJson,
    getRaw,
    // Whether the last request inherited a live connection. Read by the claim
    // path so a cold-socket claim is visible in the log instead of just slow.
    get warm() {
      return lastReusedSocket;
    },
  };
}

// Exported so a second watcher can keep its own secret in the same Keychain
// entry style instead of inventing another place to hold a password. `optional`
// is for the mail watch, which is a feature you can simply not configure.
// `envVar` is named by the caller rather than assumed, because there are two
// different secrets here and one variable standing in for both would hand the
// TeamWork password to the mail server.
export function keychainPassword(account, { optional = false, envVar } = {}) {
  // There is no Keychain on a Linux box, and the strongest single thing that can
  // be done for this bot is to run it in us-east-2 next to their ELB instead of
  // on a laptop that sleeps. So an env var is allowed to stand in there. On
  // macOS the Keychain is still where this looks first in practice, because the
  // variable is not set.
  const fromEnv = envVar ? process.env[envVar] : null;
  if (fromEnv) return fromEnv;

  try {
    return getPassword(account);
  } catch (err) {
    if (optional) return null;
    throw err;
  }
}

export async function connect(config) {
  const session = createSession(config);
  await session.signIn(keychainPassword(config.employeeUser, { envVar: 'TMWORK_PASSWORD' }));
  return session;
}

/* ---------- availability ---------- */

export async function loadTemplate(session, config) {
  const templates = await session.getJson('/api/avail/templates');
  const meta = templates.find((t) => t.Title === config.template);
  if (!meta) {
    throw new Error(
      `No template named "${config.template}". Found: ${templates.map((t) => t.Title).join(', ')}`,
    );
  }
  // Enough blank slots to write several ranges. The API returns the populated
  // ones plus this many empties.
  return { meta, template: await session.getJson(`/api/avail/template/0/${meta.Id}/?extraslots=5`) };
}

// A day is 'off', 'all-day', or a list of [fromMinutes, toMinutes] ranges.
// 'all-day' is enabled with no slots, which is exactly how TeamWork stores it.
export function readWeek(template) {
  const week = {};

  for (const day of template.Days) {
    const name = DAY_ORDER[day.DayIndex - 1];

    if (!day.Enabled) {
      week[name] = 'off';
      continue;
    }

    const ranges = (day.TimeSlots ?? [])
      .filter((slot) => slot.MinStart !== null && slot.MinEnd !== null)
      .map((slot) => [slot.MinStart, slot.MinEnd]);

    week[name] = ranges.length ? mergeRanges(ranges) : 'all-day';
  }

  return week;
}

// Canonical string for a day, used for both change detection and readback
// comparison so the three forms are never compared by identity.
export function describeDay(value) {
  if (value === 'off' || value === 'all-day') return value;

  const ranges = mergeRanges(value);
  if (!ranges.length) return 'off';
  // A single range covering the whole day is all-day by another name.
  if (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= 1440) return 'all-day';

  return ranges.map(([from, to]) => `${minutesToLabel(from)}-${minutesToLabel(to)}`).join(';');
}

// Mutates `template` in place, returning only what actually changed.
export function applyWeek(template, week) {
  const changes = [];

  for (const day of template.Days) {
    const name = DAY_ORDER[day.DayIndex - 1];
    const raw = week[name] ?? 'off';
    const want = describeDay(raw);
    const before = describeDay(readDay(day));

    if (before !== want) changes.push({ name, before, after: want });

    if (want === 'off') {
      setOff(day);
    } else if (want === 'all-day') {
      setAllDay(day);
    } else {
      setRanges(day, mergeRanges(raw));
    }
  }

  return changes;
}

function readDay(day) {
  if (!day.Enabled) return 'off';
  const ranges = (day.TimeSlots ?? [])
    .filter((slot) => slot.MinStart !== null && slot.MinEnd !== null)
    .map((slot) => [slot.MinStart, slot.MinEnd]);
  return ranges.length ? ranges : 'all-day';
}

const clearSlots = (day) => {
  for (const slot of day.TimeSlots) {
    slot.MinStart = slot.MinEnd = slot.Start = slot.End = null;
  }
};

function setOff(day) {
  day.Enabled = false;
  day.Hours = 0;
  day.PrefHours = 0;
  day.AvailTimes = '';
  clearSlots(day);
}

function setAllDay(day) {
  day.Enabled = true;
  day.Hours = 24;
  day.PrefHours = 24;
  day.AvailTimes = '';
  clearSlots(day);
}

function setRanges(day, ranges) {
  if (ranges.length > day.TimeSlots.length) {
    throw new Error(`${ranges.length} ranges needs ${ranges.length} slots, template returned ${day.TimeSlots.length}`);
  }

  day.Enabled = true;
  day.Hours = ranges.reduce((sum, [from, to]) => sum + (to - from) / 60, 0);
  // PrefHours is left alone. TeamWork's own UI does not touch it when a time is
  // set, and the preferred window is not something this tool exposes.
  day.AvailTimes = `${ranges.map(([from, to]) => `${minutesToLabel(from)}-${minutesToLabel(to)}`).join(';')};`;

  clearSlots(day);
  ranges.forEach(([from, to], i) => {
    const slot = day.TimeSlots[i];
    slot.MinStart = from;
    slot.MinEnd = to;
    slot.Start = slotIso(from);
    slot.End = slotIso(to);
  });
}

// A 200 on the PUT only means accepted, so the readback is the real proof.
function diffWeek(wanted, actual) {
  return DAY_ORDER
    .map((day) => ({
      day,
      wanted: describeDay(wanted[day] ?? 'off'),
      actual: describeDay(actual[day] ?? 'off'),
    }))
    .filter((d) => d.wanted !== d.actual);
}

// Save, re-read, compare. `week` is always what TeamWork holds, never intent.
export async function saveAndVerify(session, config, week) {
  const { meta, template } = await loadTemplate(session, config);
  const changes = applyWeek(template, week);

  if (changes.length) await session.putJson('/api/avail/template/0/', template);

  const { template: after } = await loadTemplate(session, config);
  const verified = readWeek(after);

  return {
    meta,
    week: verified,
    changes,
    saved: changes.length > 0,
    mismatches: diffWeek(week, verified),
  };
}

/* ---------- shifts ---------- */

// A search URL beats coordinates: it needs no data entry and survives a station
// being renamed. `stations` overrides the ones Google resolves badly.
export function locateStation(station, { campus = '', stations = {}, aliases = {} } = {}) {
  if (!station) return {};

  // Expanded for the map query only. The UI keeps showing the real name.
  const expanded = station.split(' ').map((word) => aliases[word] ?? word).join(' ');
  const override = stations[station];
  const query = override ?? [expanded, campus].filter(Boolean).join(', ');

  return {
    location: override ? station : query,
    mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
  };
}

// Only Start/End/Hours/StnName are relied on. The payload carries ~80 fields.
// Which button the SwapBoard would put on this row. Only 'claim' is a one-click
// take: a bid is awarded by a manager later and a trade costs a shift in
// return, so neither is something a sweep can win by being fast. Calendar
// shifts carry none of these fields, hence the defaults.
const claimMode = (item) => {
  if (item.IsMe) return 'mine';
  if (item.CanSwap === false) return 'locked';
  if (item.BidBoardId != null) return 'bid';
  if ((item.DataType ?? 0) > 9) return 'trade';
  return 'claim';
};

const toShift = (item) => ({
  id: item.Id,
  start: item.Start,
  end: item.End,
  hours: item.Hours,
  station: item.StnName,
  at: new Date(item.Start).getTime(),
  // Every button in the board's action template carries data-id, data-bid
  // (LocId) and data-cs (CheckSum), so a claim needs all three. CheckSum only
  // appears in the swapboard detail response, which is why swapboardCounts can
  // detect a shift on its own but can never take one.
  locId: item.LocId ?? null,
  checkSum: item.CheckSum ?? null,
  mode: claimMode(item),
});

// The agenda wants the weeks ahead; pay wants every week the month touches,
// including days already worked. One request per calendar week, deduped.
function weeksToFetch(today, weeks) {
  const anchors = [];

  for (let i = 0; i < weeks; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() + i * 7);
    anchors.push(d);
  }

  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  for (let d = new Date(today.getFullYear(), today.getMonth(), 1); d <= monthEnd; d.setDate(d.getDate() + 7)) {
    anchors.push(new Date(d));
  }
  anchors.push(monthEnd);

  return [...new Set(anchors.map((a) => isoDate(startOfWeek(a))))];
}

export async function loadShifts(session, { weeks = 4 } = {}) {
  const byId = new Map();

  for (const selectedDate of weeksToFetch(new Date(), weeks)) {
    const query = new URLSearchParams({
      selectedDate,
      currentView: 'week',
      showSchedule: 'true',
      showTime: 'false',
      showAvailability: 'false',
      showDaysOff: 'true',
      showEvents: 'false',
      showSwap: 'false',
      weekStart: '0',
    });

    const items = await session.getJson(`/api/employee/calendar/GetItems?${query}`);
    for (const item of items ?? []) {
      if (item?.Start) byId.set(item.Id, item);
    }
  }

  const all = [...byId.values()].map(toShift).sort((a, b) => a.at - b.at);
  const now = Date.now();

  // `shifts` drives the agenda, `all` drives pay, which counts shifts already worked.
  return { shifts: all.filter((s) => s.at >= now), all };
}

// The one call that has never been observed. Every recon pass has found an
// empty board, so the request that takes a shift is unknown. Guessing it would
// mean firing an unverified write that commits Amey to real work, so it refuses
// instead. To fill this in: with a shift on the board, run `node recon.mjs`,
// claim it by hand, quit the browser, and the capture has the request.
// Read out of their own client rather than off the wire: emp/sch-swapboard.js
// (vm.QuickClaim) and emp/Editors/shift-claim.js. There are three endpoints and
// the difference between them matters.
//
//   GET api/shift/swap/claim/?id&bid&checkSum    asks, commits to nothing
//   PUT api/shift/swap/quick-claim?id&bid&schid  takes it, one round trip
//   PUT api/shift/swap/claim?id&bid&schid        takes it, needs SchId from the GET
//   PUT api/shift/swap/request?id&bid&schid      when ApprovalRequired is set
//
// quick-claim is what the board's "Claim Now" link fires and the only one that
// takes a shift without a GET in front of it, so it is the one worth racing.
// Their QuickClaim reads data-cs into a variable and then never uses it, so the
// CheckSum really is not part of the quick path. schid is sent empty; the split
// claim flow is what fills it in.

// The server's own verdict, without taking anything. Safe to call on a real
// shift, which makes it the way to prove this path works before a write.
export async function checkClaim(session, shift) {
  const query = new URLSearchParams({
    id: String(shift.id),
    bid: String(shift.locId ?? ''),
    checkSum: String(shift.checkSum ?? ''),
  });

  const reply = await session.getJson(`/api/shift/swap/claim/?${query}`);

  return {
    canSwap: Boolean(reply?.CanSwap),
    // Some shifts need a manager to agree, in which case claiming is a request
    // and winning the race does not win the shift.
    approvalRequired: Boolean(reply?.ApprovalRequired),
    schId: reply?.SchId ?? null,
    checks: reply?.Checks ?? [],
    raw: reply,
  };
}

export async function claimShift(session, shift) {
  if (!shift?.id) throw new Error('claim needs a shift id');
  if (shift.locId == null) {
    throw new Error(`claim needs LocId, which only the swapboard listing carries (shift ${shift.id})`);
  }

  const query = `id=${encodeURIComponent(shift.id)}&bid=${encodeURIComponent(shift.locId)}&schid=`;
  const res = await session.putJson(`/api/shift/swap/quick-claim?${query}`);
  const body = res.body.trim();

  // Their client reads a null result as success and anything else as "N/A", so
  // a 200 carrying a message is a refusal. Going by the status code alone would
  // record a shift as taken when it was not.
  if (body && body !== 'null' && body !== '""') {
    throw new Error(`refused: ${body.slice(0, 200)}`);
  }

  // `ms` and `warm` are what make a lost race diagnosable. A claim that took
  // 240ms on a cold socket lost for a reason we can fix; one that took 90ms on a
  // warm one lost to somebody who was simply there first.
  return {
    id: shift.id, claimedAt: new Date().toISOString(), ms: res.ms, warm: res.reusedSocket,
  };
}

// The cheap wide view: ~84 days of per-day counts in one request, where a board
// read covers one month. Used for detection only, because it carries no Id,
// LocId or CheckSum and so can never claim anything.
//
// The date has to be the first of the current month. Their own client computes
// DATEUTIL.FirstDayOfMonth(new Date()) in getSwapCountUrl (emp/sch-swapboard.js)
// and anything else is refused. Passing today's date instead is what produced
// 169 silent 400s on 2026-08-21, took the whole counts-first read down with it,
// and left the endpoint looking rate limited when it is not.
//
// ShiftCount is shifts I hold that day. SwapCount is what is actually claimable.
// SwapToYou is the day-level "offered to you" flag.
export async function loadSwapCounts(session) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const rows = await session.getJson(
    `/api/shift/swapboardCounts?date=${isoDate(monthStart)}&fillgaps=true`,
  );

  return (rows ?? [])
    .filter((row) => typeof row?.Date === 'string')
    .map((row) => ({
      date: row.Date.slice(0, 10),
      swaps: row.SwapCount ?? 0,
      toMe: Boolean(row.SwapToYou),
    }));
}

// The board's AVAILABLE grid is rendered from api/shift/swapboard, not from
// swapboardCounts: dsSwapShifts reads the former and dsSwapCounts only feeds the
// calendar heat map. Gating the detail read on counts meant a posting that
// counts had not caught up with was never looked for at all, so the real board
// could be showing a shift while our sweep saw nothing. Asking the endpoint the
// board itself asks removes that whole class of miss, and it returns CheckSum
// and LocId at the same time, so detection and the credentials to claim arrive
// together instead of costing two round trips.
//
// range=month is verified against the live API. The current month is read every
// sweep because that is where shifts get dropped. The month after is read
// occasionally: a posting eight weeks out is not a race, and paying a second
// throttled call every sweep for it would slow down the one that matters.
const DEEP_EVERY = 20;
let sweepCount = 0;

// `via` spaces each individual request. It used to be a sleep in here, which
// only spaced the requests *within* one board read: the caller's gate stamped
// its clock once, before the read started, so on a two-anchor sweep the second
// request went out ~1.6s after that stamp and the next read's first request
// followed it by milliseconds. That is the 400 "Please wait [1.5] seconds" in
// madmax-log at 15:47 on 2026-08-21, self-inflicted, and every refusal restarts
// the 30-minute lockout clock. Handing every request to the same gate is the
// only arrangement where the spacing holds across callers as well as within one.
export async function loadOpenShifts(session, { via = (fn) => fn(), anchors: only } = {}) {
  const today = new Date();
  const anchors = only?.length ? [...new Set(only)] : [isoDate(today)];

  // A read the counts lane asked for already knows which months changed, so it
  // does not need the rotating deep read that exists to cover the horizon
  // blindly. One request, aimed.
  if (!only?.length) {
    sweepCount += 1;
    if (sweepCount % DEEP_EVERY === 1) {
      anchors.push(isoDate(new Date(today.getFullYear(), today.getMonth() + 1, 1)));
    }
  }

  const shifts = [];
  const seen = new Set();

  for (const anchor of anchors) {
    const items = await via(() => session.getJson(`/api/shift/swapboard?date=${anchor}&range=month`));

    for (const item of items ?? []) {
      if (!item?.Start || seen.has(item.Id)) continue;
      seen.add(item.Id);
      // ToMe is the row's own "offered to you" flag, which is more precise than
      // the day-level SwapToYou that counts reported.
      shifts.push({ ...toShift(item), offeredTo: Boolean(item.ToMe) });
    }
  }

  const now = Date.now();
  return shifts.filter((s) => s.at >= now).sort((a, b) => a.at - b.at);
}
