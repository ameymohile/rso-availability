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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return { meta, template: await session.getJson(`/api/avail/template/0/${meta.Id}/?extraslots=2`) };
}

export function readWeek(template) {
  const week = {};
  for (const day of template.Days) {
    week[DAY_ORDER[day.DayIndex - 1]] = day.Enabled ? 'all-day' : 'off';
  }
  return week;
}

// Mutates `template` in place, returning only what actually changed.
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
    // All-day carries no explicit slots, exactly as the real UI sends it.
    for (const slot of day.TimeSlots) {
      slot.MinStart = slot.MinEnd = slot.Start = slot.End = null;
    }
  }

  return changes;
}

// A 200 on the PUT only means accepted, so the readback is the real proof.
function diffWeek(wanted, actual) {
  return DAY_ORDER
    .map((day) => ({
      day,
      wanted: String(wanted[day] ?? 'off').toLowerCase(),
      actual: actual[day],
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
const toShift = (item) => ({
  id: item.Id,
  start: item.Start,
  end: item.End,
  hours: item.Hours,
  station: item.StnName,
  at: new Date(item.Start).getTime(),
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

// swapboardCounts covers ~3 months in one request, so an empty board costs one
// call. Only days with something get a detail fetch, which is rate limited.
export async function loadOpenShifts(session) {
  const counts = await session.getJson(
    `/api/shift/swapboardCounts?date=${isoDate(new Date())}&fillgaps=true`,
  );
  const active = (counts ?? []).filter((day) => (day.SwapCount ?? 0) > 0 || day.SwapToYou);

  const shifts = [];
  for (const [index, day] of active.entries()) {
    if (index) await sleep(SWAPBOARD_THROTTLE_MS);
    const items = await session.getJson(`/api/shift/swapboard?date=${day.Date.slice(0, 10)}&range=day`);
    for (const item of items ?? []) {
      if (item?.Start) shifts.push({ ...toShift(item), offeredTo: Boolean(day.SwapToYou) });
    }
  }

  const now = Date.now();
  return shifts.filter((s) => s.at >= now).sort((a, b) => a.at - b.at);
}
