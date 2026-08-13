// Loads the current week, lets you toggle days, saves, and then reports what
// TeamWork actually stored -- not what we asked it to store.
//
// Upcoming shifts are shown separately and are purely informational. Because
// availability is submitted fresh each week, an already-booked shift says
// nothing about the week you are filling in now.

const DAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday',
];

const WEEK_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const CAL_WEEKS = 4;

const CHECK = `<svg class="check" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M4 12.5 L9.5 18 L20 6.5" /></svg>`;

const el = {
  days: document.getElementById('days'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
  subtitle: document.getElementById('subtitle'),
  eyebrow: document.getElementById('eyebrow'),
  open: document.getElementById('open'),
  openBody: document.getElementById('openBody'),
  openChecked: document.getElementById('openChecked'),
  refresh: document.getElementById('refresh'),
  shifts: document.getElementById('shifts'),
  calMonth: document.getElementById('calMonth'),
  cal: document.getElementById('cal'),
  agenda: document.getElementById('agenda'),
  shiftsSummary: document.getElementById('shiftsSummary'),
  history: document.getElementById('history'),
  topbar: document.getElementById('topbar'),
  pill: document.getElementById('pill'),
  pillText: document.getElementById('pillText'),
  log: document.getElementById('log'),
  alerts: document.getElementById('alerts'),
};

// `live` is what TeamWork confirmed it holds; `draft` is what the switches show.
let live = null;
let draft = null;
let verifiedAt = null;
let busy = false;
let openShifts = [];
let openCheckedAt = null;
let openSeen = new Set();
let checking = false;

const label = (day) => day[0].toUpperCase() + day.slice(1);
const isDirty = () => DAYS.some((d) => live[d] !== draft[d]);
const countOn = (week) => DAYS.filter((d) => week[d] === 'all-day').length;
const listDays = (days) => days.map(label).join(', ');

// Local YYYY-MM-DD. Not toISOString(), which shifts to UTC and can land an
// 8pm Eastern shift on the following day.
const dateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const startOfWeek = (from = new Date()) => {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
};

const fmtTime = (iso) =>
  new Date(iso)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(':00', '');

function relativeTime(iso) {
  const seconds = Math.round((Date.now() - new Date(iso)) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 90) return 'a minute ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
}

// Lead with what the reader can do about it; keep the raw error underneath as
// a quiet second line so debugging is still possible without owning the UI.
function humanize(message) {
  if (/invalid token|401|app\.token|password/i.test(message)) {
    return 'TeamWork signed us out. Try again, and re-check the saved password if it keeps happening.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Cannot reach the local server. Is it still running?';
  }
  return 'Could not save to TeamWork. Try again.';
}

function setStatus(message, tone = '', detail = '') {
  el.status.className = `status${tone ? ` ${tone}` : ''}`;
  el.status.replaceChildren(document.createTextNode(message));
  if (detail && detail !== message) {
    const line = document.createElement('span');
    line.className = 'detail';
    line.textContent = detail;
    el.status.append(line);
  }
}

function setBusy(value) {
  busy = value;
  el.days.classList.toggle('busy', value);
  el.days.querySelectorAll('input').forEach((input) => { input.disabled = value; });
}

/* ---------- availability ---------- */

function render() {
  el.days.setAttribute('aria-busy', 'false');
  el.days.replaceChildren(...DAYS.map(buildRow));
  syncFooter();
  renderAlerts();
}

function buildRow(day) {
  const on = draft[day] === 'all-day';

  const row = document.createElement('div');
  row.className = `row${on ? ' on' : ''}`;

  const name = document.createElement('span');
  name.className = 'day';
  name.textContent = label(day);

  const state = document.createElement('span');
  state.className = 'state';
  state.textContent = on ? 'All day' : 'Off';

  const wrap = document.createElement('label');
  wrap.className = 'switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = on;
  input.disabled = busy;
  input.setAttribute('aria-label', `${label(day)} availability`);
  input.addEventListener('change', () => {
    draft[day] = input.checked ? 'all-day' : 'off';
    row.classList.toggle('on', input.checked);
    state.textContent = input.checked ? 'All day' : 'Off';
    syncFooter();
  });

  const track = document.createElement('span');
  track.className = 'track';

  wrap.append(input, track);
  row.append(name, state, wrap);

  // Clicking the switch already works via the label; this makes the rest of
  // the row a target too, which matters far more with a mouse than a thumb.
  row.addEventListener('click', (event) => {
    if (busy || event.target.closest('.switch')) return;
    input.click();
  });

  return row;
}

function syncFooter() {
  const dirty = isDirty();
  el.save.className = 'save';
  el.save.disabled = !dirty;
  el.save.textContent = dirty ? 'Save changes' : 'Saved';

  const n = countOn(draft);
  el.subtitle.textContent = n === 0
    ? 'Not available any day this week.'
    : `Available ${n} ${n === 1 ? 'day' : 'days'} a week, all day.`;

  if (dirty) {
    const changed = DAYS.filter((d) => live[d] !== draft[d]);
    setStatus(`${listDays(changed)} not saved yet`);
  } else {
    setStatus(verifiedAt ? `Verified with TeamWork ${relativeTime(verifiedAt)}` : '');
  }
}

/* ---------- upcoming shifts ---------- */

let myShifts = [];
let shiftsLoaded = false;

function renderShifts(shifts) {
  myShifts = shifts;
  shiftsLoaded = true;
  if (!shifts.length) {
    el.shifts.hidden = false;
    el.calMonth.textContent = '';
    el.cal.replaceChildren();
    el.agenda.replaceChildren();
    el.shiftsSummary.textContent = 'Nothing scheduled in the next four weeks.';
    renderAlerts();
    return;
  }

  el.shifts.hidden = false;

  const hours = shifts.reduce((sum, s) => sum + (s.hours ?? 0), 0);
  el.shiftsSummary.textContent =
    `${shifts.length} ${shifts.length === 1 ? 'shift' : 'shifts'} · ${hours} hours`;

  renderCalendar(shifts);
  renderAgenda(shifts);
  renderAlerts();
}

function renderCalendar(shifts) {
  const counts = new Map();
  for (const shift of shifts) {
    const key = dateKey(new Date(shift.start));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const first = startOfWeek();
  const last = new Date(first);
  last.setDate(first.getDate() + CAL_WEEKS * 7 - 1);

  // "August" or "August – September" depending on whether the window spans one.
  const monthName = (d) => d.toLocaleDateString(undefined, { month: 'long' });
  el.calMonth.textContent = first.getMonth() === last.getMonth()
    ? `${monthName(first)} ${first.getFullYear()}`
    : `${monthName(first)} – ${monthName(last)} ${last.getFullYear()}`;

  const cells = WEEK_INITIALS.map((initial, i) => {
    const head = document.createElement('span');
    head.className = 'cal-head';
    head.textContent = initial;
    head.setAttribute('aria-hidden', 'true');
    // Two columns share the letter S and two share T, so give assistive tech
    // the real name instead of a bare initial.
    head.title = DAYS[i];
    return head;
  });

  const todayKey = dateKey(new Date());

  for (let i = 0; i < CAL_WEEKS * 7; i += 1) {
    const date = new Date(first);
    date.setDate(first.getDate() + i);
    const key = dateKey(date);
    const count = counts.get(key) ?? 0;

    const cell = document.createElement('span');
    cell.className = 'cal-day';
    if (key === todayKey) cell.classList.add('today');
    if (key < todayKey) cell.classList.add('past');
    if (count) cell.classList.add('has-shift');

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = date.getDate();
    cell.append(num);

    // Always present, even when empty, so every row keeps the same height.
    const dots = document.createElement('span');
    dots.className = 'dots';
    // Two dots max; the agenda below carries the detail.
    for (let d = 0; d < Math.min(count, 2); d += 1) {
      dots.append(document.createElement('i'));
    }
    cell.append(dots);
    if (count) cell.title = `${count} ${count === 1 ? 'shift' : 'shifts'}`;

    cells.push(cell);
  }

  el.cal.replaceChildren(...cells);
}

function renderAgenda(shifts) {
  const thisWeek = startOfWeek().getTime();
  const weekOf = (iso) => Math.round((startOfWeek(new Date(iso)).getTime() - thisWeek) / 604800000);
  const heading = (offset) => {
    if (offset <= 0) return 'This week';
    if (offset === 1) return 'Next week';
    return `In ${offset} weeks`;
  };

  const items = [];
  let lastOffset = null;

  for (const shift of shifts) {
    const offset = weekOf(shift.start);
    if (offset !== lastOffset) {
      lastOffset = offset;
      const li = document.createElement('li');
      li.className = 'agenda-group';
      li.textContent = heading(offset);
      items.push(li);
    }

    const start = new Date(shift.start);

    const li = document.createElement('li');
    li.className = 'agenda-item';

    const when = document.createElement('span');
    when.className = 'when';
    const dow = document.createElement('span');
    dow.className = 'dow';
    dow.textContent = start.toLocaleDateString(undefined, { weekday: 'short' });
    const dnum = document.createElement('span');
    dnum.className = 'dnum';
    dnum.textContent = start.getDate();
    when.append(dow, dnum);

    const body = document.createElement('span');
    body.className = 'body';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `${fmtTime(shift.start)} – ${fmtTime(shift.end)}`;
    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = shift.station ?? '';
    body.append(time, place);

    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = `${shift.hours}h`;

    li.append(when, body, dur);
    items.push(li);
  }

  el.agenda.replaceChildren(...items);
}

/* ---------- open shifts ---------- */

// A shift you could pick up that overlaps one you already hold is worth
// flagging, unlike an availability "conflict" which is meaningless here.
function overlapsExisting(shift) {
  const start = new Date(shift.start).getTime();
  const end = new Date(shift.end).getTime();
  return myShifts.some((mine) => {
    const ms = new Date(mine.start).getTime();
    const me = new Date(mine.end).getTime();
    return start < me && ms < end;
  });
}

function buildOpenRow(shift, isNew) {
  const start = new Date(shift.start);

  const li = document.createElement('li');
  li.className = `agenda-item open-item${isNew ? ' is-new' : ''}`;

  const when = document.createElement('span');
  when.className = 'when';
  const dow = document.createElement('span');
  dow.className = 'dow';
  dow.textContent = start.toLocaleDateString(undefined, { weekday: 'short' });
  const dnum = document.createElement('span');
  dnum.className = 'dnum';
  dnum.textContent = start.getDate();
  when.append(dow, dnum);

  const body = document.createElement('span');
  body.className = 'body';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = `${fmtTime(shift.start)} – ${fmtTime(shift.end)}`;
  const place = document.createElement('span');
  place.className = 'place';
  const bits = [shift.station, `${shift.hours}h`].filter(Boolean);
  if (shift.offeredTo) bits.push('offered to you');
  if (overlapsExisting(shift)) bits.push('clashes with a shift you have');
  place.textContent = bits.join(' · ');
  if (overlapsExisting(shift)) place.classList.add('clash');
  body.append(time, place);

  // Claiming is not wired up yet: the write API has never been observed, and
  // guessing at a request that commits you to work is not acceptable. Until a
  // real claim is captured this hands off to TeamWork.
  const claim = document.createElement('a');
  claim.className = 'claim';
  claim.textContent = 'Claim ↗';
  claim.href = 'https://www.tmwork.net/emp/#!sch-swapboard';
  claim.target = '_blank';
  claim.rel = 'noopener';

  li.append(when, body, claim);
  return li;
}

function renderOpenShifts() {
  el.openBody.replaceChildren();

  if (!openShifts.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    if (openCheckedAt) {
      empty.append(
        document.createTextNode('Nothing on the board right now.'),
        Object.assign(document.createElement('span'), {
          className: 'empty-sub',
          textContent: 'Rechecking every minute while this page is open.',
        }),
      );
    } else {
      empty.textContent = 'Checking the board…';
    }
    el.openBody.append(empty);
    syncChecked();
    return;
  }

  const list = document.createElement('ul');
  list.className = 'open-list';
  for (const shift of openShifts) {
    list.append(buildOpenRow(shift, !openSeen.has(shift.id)));
  }
  el.openBody.append(list);

  const note = document.createElement('p');
  note.className = 'foot-note';
  note.textContent = 'Claim opens TeamWork for now. One-tap claiming needs one real shift captured first.';
  el.openBody.append(note);

  syncChecked();
}

// The pill reports the health of the link to TeamWork. How many shifts are on
// the board is already answered by the panel right below it, and one indicator
// trying to say two things says neither clearly.
const LINK_STATES = {
  live: ['', 'TeamWork · live'],
  syncing: ['busy', 'TeamWork · syncing'],
  down: ['warn', 'TeamWork · unreachable'],
};

function setLink(state) {
  const [tone, text] = LINK_STATES[state];
  el.pill.hidden = false;
  el.pill.className = `pill${tone ? ` ${tone}` : ''}`;
  el.pillText.textContent = text;
}

function syncChecked() {
  if (!openCheckedAt) return void (el.openChecked.textContent = '');
  const checked = `checked ${relativeTime(openCheckedAt)}`;
  el.openChecked.textContent = openShifts.length
    ? `${openShifts.length} open · ${checked}`
    : checked;
}

async function checkOpenShifts({ notify = false } = {}) {
  if (checking) return;
  checking = true;
  el.refresh.classList.add('spinning');
  setLink('syncing');

  try {
    const data = await api('/api/open-shifts');
    const fresh = data.shifts.filter((s) => !openSeen.has(s.id));

    openShifts = data.shifts;
    openCheckedAt = data.checkedAt;
    renderOpenShifts();
    setLink('live');

    if (notify && fresh.length) announce(fresh);
    for (const s of data.shifts) openSeen.add(s.id);
  } catch (err) {
    el.openChecked.textContent = 'check failed';
    setLink('down');
    console.warn('open shifts unavailable:', err.message);
  } finally {
    checking = false;
    el.refresh.classList.remove('spinning');
  }
}

// A banner is the whole point when the tab is sitting in the background.
function announce(fresh) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const first = fresh[0];
  const when = new Date(first.start);
  new Notification(
    fresh.length === 1 ? 'A shift is on the board' : `${fresh.length} shifts on the board`,
    {
      body: `${when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtTime(first.start)} · ${first.station ?? ''}`,
      tag: 'rso-open-shifts',
    },
  );
}

el.refresh.addEventListener('click', () => {
  // Permission can only be requested from a real user gesture.
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  checkOpenShifts({ notify: true });
});

// Polls for as long as the page is open, including in a background tab --
// leaving it open on a Friday is the whole point, and a hidden tab is exactly
// when the notification matters. Backs off while hidden to stay light. Closing
// the tab stops it completely; there is no daemon.
const POLL_VISIBLE_MS = 60000;
const POLL_HIDDEN_MS = 150000;

let pollTimer = null;

function schedulePoll() {
  clearInterval(pollTimer);
  const every = document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
  pollTimer = setInterval(() => {
    checkOpenShifts({ notify: true });
    refreshWeek();
  }, every);
}

document.addEventListener('visibilitychange', () => {
  schedulePoll();
  if (document.visibilityState !== 'visible') return;
  // Coming back to the tab, show something current rather than minutes stale.
  const age = openCheckedAt ? Date.now() - new Date(openCheckedAt) : Infinity;
  if (age > POLL_VISIBLE_MS) checkOpenShifts({ notify: true });
});

schedulePoll();


/* ---------- weekly readiness ---------- */

// You need at least one shift a week to keep the job, and availability has to
// be re-entered each week. Both are easy to forget and neither is visible
// anywhere until it is too late.

const WEEK_MS = 604800000;

function weekStartOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function shiftsInWeek(offset) {
  const start = weekStartOf(new Date()).getTime() + offset * WEEK_MS;
  return myShifts.filter((s) => {
    const w = weekStartOf(new Date(s.start)).getTime();
    return w === start;
  });
}

// Days left until next week starts. Drives how loud the warning gets.
function daysUntilNextWeek() {
  const nextWeek = weekStartOf(new Date()).getTime() + WEEK_MS;
  return Math.ceil((nextWeek - Date.now()) / 86400000);
}

function readiness() {
  const alerts = [];

  // Every day off almost certainly means TeamWork reset it and it has not been
  // filled in yet, rather than a deliberate "I cannot work at all this week".
  if (live && countOn(live) === 0) {
    alerts.push({
      level: 'warn',
      text: 'Availability is empty. Set your days and save.',
    });
  }

  // myShifts is only populated once /api/shifts lands; say nothing until then
  // rather than flash a false "no shifts" warning on load.
  if (shiftsLoaded) {
    const next = shiftsInWeek(1);
    const days = daysUntilNextWeek();
    if (!next.length) {
      alerts.push({
        level: days <= 2 ? 'bad' : 'warn',
        text: days <= 2
          ? `No shifts next week, and it starts in ${days === 1 ? 'a day' : days + ' days'}. You need one.`
          : 'No shifts booked for next week yet.',
      });
    }

    const thisWeek = shiftsInWeek(0);
    if (!thisWeek.length) {
      alerts.push({ level: 'bad', text: 'No shifts this week.' });
    }
  }

  return alerts;
}

function renderAlerts() {
  const alerts = readiness();
  el.alerts.hidden = alerts.length === 0;
  el.alerts.replaceChildren(...alerts.map((a) => {
    const div = document.createElement('div');
    div.className = `alert ${a.level}`;
    const dot = document.createElement('i');
    div.append(dot, document.createTextNode(a.text));
    return div;
  }));
}

/* ---------- history ---------- */

function renderHistory(entries) {
  if (!entries.length) {
    el.history.hidden = true;
    return;
  }

  el.history.hidden = false;
  el.log.replaceChildren(...entries.slice(0, 6).map((entry) => {
    const li = document.createElement('li');

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(entry.at).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });

    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = entry.changes
      .map((c) => `${label(c.name)} ${c.after === 'all-day' ? 'on' : 'off'}`)
      .join(', ');

    li.append(when, what);
    if (!entry.verified) li.classList.add('unverified');
    return li;
  }));
}

/* ---------- wiring ---------- */

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

async function load() {
  try {
    const data = await api('/api/week');
    el.eyebrow.textContent = data.template;
    live = data.week;
    draft = { ...data.week };
    verifiedAt = data.at;
    render();
  } catch (err) {
    el.days.setAttribute('aria-busy', 'false');
    el.days.replaceChildren();
    el.subtitle.textContent = 'Could not reach TeamWork.';
    setLink('down');
    setStatus(humanize(err.message), 'error', err.message);
    return;
  }

  // Both are extras. Fetch them after the week is on screen, and never let a
  // failure here take down the part that matters.
  api('/api/shifts')
    .then((data) => renderShifts(data.shifts))
    .catch((err) => console.warn('shifts unavailable:', err.message));

  refreshHistory();
  checkOpenShifts();
}

// The toggles are TeamWork's state, not ours. If TeamWork resets the week
// while this page is open, the page has to follow. Skipped whenever there are
// unsaved edits, because clobbering a draft mid-thought is worse than stale.
async function refreshWeek() {
  if (busy || !live || isDirty()) return;
  try {
    const data = await api('/api/week');
    verifiedAt = data.at;
    const changed = DAYS.some((d) => live[d] !== data.week[d]);
    if (!changed) return void syncFooter();
    live = data.week;
    draft = { ...data.week };
    render();
  } catch (err) {
    console.warn('week refresh failed:', err.message);
  }
}

function refreshHistory() {
  api('/api/history')
    .then((data) => renderHistory(data.history))
    .catch((err) => console.warn('history unavailable:', err.message));
}

// Flash the confirmed state, then settle back to the quiet resting look.
function celebrate() {
  el.save.className = 'save success';
  el.save.innerHTML = `${CHECK}<span>Saved</span>`;
  setTimeout(() => { if (!isDirty()) syncFooter(); }, 1800);
}

el.save.addEventListener('click', async () => {
  el.save.disabled = true;
  el.save.className = 'save';
  el.save.textContent = 'Saving…';
  setStatus('');
  setBusy(true);
  setLink('syncing');

  try {
    const data = await api('/api/week', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ week: draft }),
    });

    // The server re-read TeamWork after writing, so `data.week` is the truth.
    // Trust it over what we asked for, even when they disagree.
    live = data.week;
    draft = { ...data.week };
    verifiedAt = data.at;
    setBusy(false);
    render();
    refreshHistory();

    setLink('live');

    if (data.verified) {
      celebrate();
      setStatus(`Verified with TeamWork ${relativeTime(data.at)}`, 'ok');
      return;
    }

    // Wrote without error, but the readback disagrees. Say exactly which days,
    // and show TeamWork's version rather than ours.
    el.save.className = 'save failure';
    el.save.textContent = 'Not fully saved';
    setStatus(
      `TeamWork kept ${listDays(data.mismatches.map((m) => m.day))} differently. Showing what it actually has.`,
      'error',
    );
  } catch (err) {
    setBusy(false);
    setLink('down');
    el.save.className = 'save';
    el.save.textContent = 'Save changes';
    el.save.disabled = false;
    setStatus(humanize(err.message), 'error', err.message);
  }
});

// Keep the "verified 5 min ago" line honest without a page refresh.
setInterval(() => {
  if (verifiedAt && !isDirty() && !busy) syncFooter();
  syncChecked();
  renderAlerts();
}, 30000);

load();

/* ---------- appearance ---------- */

// Three states rather than a binary toggle: "auto" has to stay reachable, or
// you can never get back to following the system once you have overridden it.
const THEMES = ['auto', 'light', 'dark'];

function currentTheme() {
  try {
    const saved = localStorage.getItem('theme');
    return THEMES.includes(saved) ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;

  try { localStorage.setItem('theme', theme); } catch {}

  for (const button of document.querySelectorAll('[data-theme-set]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeSet === theme));
  }
}

for (const button of document.querySelectorAll('[data-theme-set]')) {
  button.addEventListener('click', () => applyTheme(button.dataset.themeSet));
}

applyTheme(currentTheme());

/* ---------- keyboard ---------- */

document.addEventListener('keydown', (event) => {
  const meta = event.metaKey || event.ctrlKey;

  if (meta && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!el.save.disabled) el.save.click();
    return;
  }

  if (meta && event.key === '\\') {
    event.preventDefault();
    const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    applyTheme(next);
    return;
  }

  // Bare letters only when not typing into something.
  if (meta || event.altKey || /input|textarea/i.test(event.target.tagName)) return;
  if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    el.refresh.click();
  }
});

/* ---------- sticky header rule ---------- */

const onScroll = () => el.topbar.classList.toggle('scrolled', window.scrollY > 4);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();
