// TeamWork (tmwork.net) client. Shared by the CLI (avail.mjs) and the local
// web UI (server.mjs) so the sign-in and save logic exists in exactly one place.
//
// See README.md for how the API auth works and how it was worked out.

import { execFileSync } from 'node:child_process';

export const BASE = 'https://www.tmwork.net';
const KEYCHAIN_SERVICE = 'tmwork-rso';

// TeamWork numbers days 1..7 starting at Sunday, confirmed against the day
// labels rendered in the availability table.
export const DAY_ORDER = [
  'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday',
];

export function getPassword(account) {
  try {
    return execFileSync('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w',
    ], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'No Keychain entry found. Store it once with:\n' +
      `  security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${account} -w`,
    );
  }
}

// One session == one cookie jar + one API token. Kept per-instance rather than
// module-global so the server can hold several without them treading on each
// other.
export function createSession(config) {
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
        // The /api/ endpoints reject cookie auth outright with "Invalid Token".
        // Cookies alone are not enough, and this header alone is not either.
        ...(apiToken && url.includes('/api/') ? { 'x-api-token': apiToken } : {}),
        ...options.headers,
      },
    });
    storeCookies(res);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        // Redirects after a POST are followed as GET, per normal browser rules.
        return request(new URL(location, url).href, { headers: options.headers }, hops + 1);
      }
    }
    return res;
  }

  async function signIn(password) {
    // The sign-in page carries an ASP.NET antiforgery token that the POST must
    // echo back, alongside the matching cookie.
    const page = await request(`${BASE}/signin`);
    const antiforgery = (await page.text()).match(
      /name="__RequestVerificationToken"[^>]*value="([^"]+)"/,
    )?.[1];
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

    // A bad password re-renders the sign-in page instead of returning an error
    // status, and the shell only carries APP.Token when we are really signed
    // in, so a missing token here means the sign-in silently failed.
    const shell = await request(`${BASE}/emp/`);
    apiToken = (await shell.text()).match(/APP\.Token\s*=\s*'([^']+)'/)?.[1] ?? null;
    if (!apiToken) {
      throw new Error('Signed in but found no APP.Token in /emp/. The password in your Keychain is probably wrong.');
    }
  }

  async function getJson(path) {
    const res = await request(`${BASE}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
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

  return { signIn, getJson, putJson, get isSignedIn() { return Boolean(apiToken); } };
}

// Resolves the configured template name to its full object.
export async function loadTemplate(session, config) {
  const templates = await session.getJson('/api/avail/templates');
  const meta = templates.find((t) => t.Title === config.template);
  if (!meta) {
    throw new Error(
      `No template named "${config.template}". Found: ${templates.map((t) => t.Title).join(', ')}`,
    );
  }
  const template = await session.getJson(`/api/avail/template/0/${meta.Id}/?extraslots=2`);
  return { meta, template };
}

// Reads a template into the simple shape the UI and CLI both think in.
export function readWeek(template) {
  const week = {};
  for (const day of template.Days) {
    week[DAY_ORDER[day.DayIndex - 1]] = day.Enabled ? 'all-day' : 'off';
  }
  return week;
}

// Mutates `template` in place to match `week`, returning what changed.
export function applyWeek(template, week) {
  const changes = [];
  for (const day of template.Days) {
    const name = DAY_ORDER[day.DayIndex - 1];
    const want = String(week[name] ?? 'off').toLowerCase();
    if (want !== 'off' && want !== 'all-day') {
      throw new Error(`"${name}" is "${want}", but only "off" and "all-day" are supported`);
    }

    const enabled = want === 'all-day';
    const before = day.Enabled ? 'all-day' : 'off';
    if (before !== want) changes.push({ name, before, after: want });

    day.Enabled = enabled;
    day.Hours = enabled ? 24 : 0;
    day.PrefHours = enabled ? 24 : 0;
    day.AvailTimes = '';
    // All-day means no explicit slots; leave them null exactly as the UI does.
    for (const slot of day.TimeSlots) {
      slot.MinStart = slot.MinEnd = slot.Start = slot.End = null;
    }
  }
  return changes;
}

export const saveTemplate = (session, template) =>
  session.putJson('/api/avail/template/0/', template);

// Local YYYY-MM-DD. Deliberately not toISOString(), which converts to UTC and
// can land on the wrong day for evening shifts in Eastern time.
const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Upcoming rostered shifts, shown for reference. Availability is submitted
// fresh each week, so an already-booked shift is not a conflict with the week
// being filled in -- it is just useful to see. The calendar endpoint serves one
// week at a time, so ask for several and merge.
//
// Only `Start`/`End`/`Title`/`Hours`/`StnName` are relied on here. The payload
// has ~80 fields whose meaning is not documented anywhere we can see, so we
// deliberately touch as few as possible.
export async function loadShifts(session, { weeks = 4 } = {}) {
  const today = new Date();

  // Two things are needed and they are not the same range. The agenda wants the
  // next few weeks; a month total wants every week the current month touches,
  // including days already worked. Fetch the union once and slice it after.
  const anchors = [];
  for (let i = 0; i < weeks; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() + i * 7);
    anchors.push(d);
  }

  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  for (
    let d = new Date(today.getFullYear(), today.getMonth(), 1);
    d <= monthEnd;
    d.setDate(d.getDate() + 7)
  ) {
    anchors.push(new Date(d));
  }
  anchors.push(monthEnd);

  // One request per calendar week, deduped, since several anchors land in the
  // same week.
  const fetched = new Set();
  const byId = new Map();

  for (const anchor of anchors) {
    const weekStart = new Date(anchor);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const key = isoDate(weekStart);
    if (fetched.has(key)) continue;
    fetched.add(key);

    const query = new URLSearchParams({
      selectedDate: key,
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
      if (!item?.Start) continue;
      byId.set(item.Id, item);
    }
  }

  const all = [...byId.values()].map(toShift).sort((a, b) => a.at - b.at);
  const now = Date.now();

  // `shifts` drives the agenda and calendar, `all` drives pay, which has to
  // count a shift you already worked on Monday.
  return { shifts: all.filter((s) => s.at >= now), all };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalises a TeamWork shift object into the small shape the UI thinks in.
// The payload carries ~80 fields; we touch as few as possible.
function toShift(item) {
  const start = new Date(item.Start);
  return {
    id: item.Id,
    start: item.Start,
    end: item.End,
    hours: item.Hours,
    station: item.StnName,
    title: item.Title,
    // Who currently holds it. Absent on genuinely open shifts.
    heldBy: item.EmpName ?? null,
    day: DAY_ORDER[start.getDay()],
    at: start.getTime(),
  };
}

// Shifts available to pick up, from the SwapBoard.
//
// swapboardCounts returns ~3 months of per-day counts in ONE request, so the
// common case (an empty board) costs a single call. Only days that actually
// have something get a detail fetch.
//
// /api/shift/swapboard rate-limits: calling it faster than every 1.5s returns
// 400 "Please wait [1.5] seconds to refresh list.", so detail fetches are
// spaced out.
export async function loadOpenShifts(session) {
  const counts = await session.getJson(
    `/api/shift/swapboardCounts?date=${isoDate(new Date())}&fillgaps=true`,
  );

  const active = (counts ?? []).filter(
    (day) => (day.SwapCount ?? 0) > 0 || day.SwapToYou,
  );

  const shifts = [];
  for (const [index, day] of active.entries()) {
    if (index) await sleep(1600);
    const date = day.Date.slice(0, 10);
    const items = await session.getJson(`/api/shift/swapboard?date=${date}&range=day`);
    for (const item of items ?? []) {
      if (item?.Start) shifts.push({ ...toShift(item), offeredTo: Boolean(day.SwapToYou) });
    }
  }

  const now = Date.now();
  return {
    shifts: shifts.filter((s) => s.at >= now).sort((a, b) => a.at - b.at),
    daysScanned: counts?.length ?? 0,
    daysWithItems: active.length,
  };
}

// Closes the loop: compares what we asked TeamWork to store against what it
// actually reports back afterwards. A PUT returning 200 only means the request
// was accepted, not that every field survived, so the readback is the real
// proof. Returns [] when the two agree.
export function diffWeek(wanted, actual) {
  return DAY_ORDER
    .map((day) => ({
      day,
      wanted: String(wanted[day] ?? 'off').toLowerCase(),
      actual: actual[day],
    }))
    .filter((d) => d.wanted !== d.actual);
}

// Save, then re-fetch and verify. The returned `week` is what TeamWork really
// holds, never what we hoped it would hold.
export async function saveAndVerify(session, config, week) {
  const { meta, template } = await loadTemplate(session, config);
  const changes = applyWeek(template, week);

  if (changes.length) await saveTemplate(session, template);

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

// Sign in and hand back a ready session in one step.
export async function connect(config) {
  const session = createSession(config);
  await session.signIn(getPassword(config.employeeUser));
  return session;
}
