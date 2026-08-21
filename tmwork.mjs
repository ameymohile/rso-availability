// TeamWork (tmwork.net) client, shared by the CLI and the local server.
// API notes and how it was worked out: NOTES.md.

import { execFileSync } from 'node:child_process';

const BASE = 'https://www.tmwork.net';
const KEYCHAIN_SERVICE = 'tmwork-rso';
const SWAPBOARD_THROTTLE_MS = 1600;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const isoDate = (d) =>
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
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  async function request(url, options = {}, hops = 0) {
    if (hops > 5) throw new Error(`Too many redirects: ${url}`);

    const res = await fetch(url, {
      ...options,
      redirect: 'manual',
      headers: {
        cookie: cookieHeader(),
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        // /api/ rejects cookies alone with "Invalid Token". Both are required.
        ...(apiToken && url.includes('/api/') ? { 'x-api-token': apiToken } : {}),
        ...options.headers,
      },
    });
    storeCookies(res);

    const location = res.status >= 300 && res.status < 400 && res.headers.get('location');
    // Redirects after a POST are followed as GET, per normal browser rules.
    return location
      ? request(new URL(location, url).href, { headers: options.headers }, hops + 1)
      : res;
  }

  async function signIn(password) {
    const page = await request(`${BASE}/signin`);
    const antiforgery = (await page.text())
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
      }),
    });

    // A bad password re-renders the form instead of erroring, so a missing
    // APP.Token is how a silent failure shows up.
    const shell = await request(`${BASE}/emp/`);
    apiToken = (await shell.text()).match(/APP\.Token\s*=\s*'([^']+)'/)?.[1] ?? null;
    if (!apiToken) {
      throw new Error('Signed in but found no APP.Token in /emp/. The Keychain password is probably wrong.');
    }
  }

  async function getJson(path) {
    const res = await request(`${BASE}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      // The body carries the reason, e.g. the "Please wait [1.5] seconds"
      // throttle. Dropping it made rate limits look like generic failures.
      const detail = (await res.text().catch(() => '')).slice(0, 200).trim();
      throw new Error(`GET ${path} -> ${res.status}${detail ? ` ${detail}` : ''}`);
    }
    return res.json();
  }

  async function putJson(path, payload) {
    const res = await request(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`PUT ${path} -> ${res.status} ${await res.text()}`);
    return res;
  }

  return { signIn, getJson, putJson };
}

export async function connect(config) {
  const session = createSession(config);
  await session.signIn(getPassword(config.employeeUser));
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
export async function claimShift(session, shift) {
  throw new Error(
    `claim not implemented: the SwapBoard claim request has never been captured `
    + `(shift ${shift.id}). Run recon.mjs while claiming one by hand.`,
  );
}

// Remembering the previous per-week counts is what lets a sweep tell a week
// that just gained a shift from one that has been sitting there all along.
let lastWeekCounts = new Map();

// swapboardCounts covers ~3 months in one request, so an empty board costs one
// call. Only weeks with something get a detail fetch, which is rate limited.
export async function loadOpenShifts(session) {
  const counts = await session.getJson(
    `/api/shift/swapboardCounts?date=${isoDate(new Date())}&fillgaps=true`,
  );
  const active = (counts ?? []).filter((day) => (day.SwapCount ?? 0) > 0 || day.SwapToYou);

  // range=day returns that day alone, so a board spread over four days used to
  // cost four throttled calls and 4.8s of sleep before the last one was even
  // seen. range=week covers all of them, and the board itself defaults to it.
  // Any date in the week works; anchoring on the Sunday makes weeks dedupe.
  const weeks = new Map();
  const offeredOn = new Set();

  for (const day of active) {
    const date = day.Date.slice(0, 10);
    if (day.SwapToYou) offeredOn.add(date);

    const anchor = isoDate(startOfWeek(`${date}T00:00:00`));
    const week = weeks.get(anchor) ?? { anchor, count: 0, offered: false };
    week.count += day.SwapCount ?? 0;
    week.offered = week.offered || Boolean(day.SwapToYou);
    weeks.set(anchor, week);
  }

  // Fetch the interesting week first. Offered-to-me outranks everything, then
  // whatever grew since the last sweep, so a new shift never waits behind the
  // throttle for weeks that have not changed.
  const rank = (w) => {
    if (w.offered) return 0;
    return w.count > (lastWeekCounts.get(w.anchor) ?? 0) ? 1 : 2;
  };
  const ordered = [...weeks.values()].sort((a, b) => rank(a) - rank(b));
  lastWeekCounts = new Map(ordered.map((w) => [w.anchor, w.count]));

  const shifts = [];
  const seen = new Set();

  for (const [index, week] of ordered.entries()) {
    if (index) await sleep(SWAPBOARD_THROTTLE_MS);
    const items = await session.getJson(`/api/shift/swapboard?date=${week.anchor}&range=week`);

    for (const item of items ?? []) {
      if (!item?.Start || seen.has(item.Id)) continue;
      seen.add(item.Id);
      // SwapToYou belongs to a day, not a week, so it has to be matched back to
      // the shift's own date rather than the week that was requested.
      shifts.push({ ...toShift(item), offeredTo: offeredOn.has(item.Start.slice(0, 10)) });
    }
  }

  const now = Date.now();
  return shifts.filter((s) => s.at >= now).sort((a, b) => a.at - b.at);
}
