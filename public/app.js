// The whole UI. Reports what TeamWork stored, never what we asked it to store.

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
  pay: document.getElementById('pay'),
  payRows: document.getElementById('payRows'),
  payNote: document.getElementById('payNote'),
  payToggle: document.getElementById('payToggle'),
  syncCal: document.getElementById('syncCal'),
  backdrop: document.getElementById('backdrop'),
  sheetTitle: document.getElementById('sheetTitle'),
  sheetBody: document.getElementById('sheetBody'),
  sheetOk: document.getElementById('sheetOk'),
  sheetCancel: document.getElementById('sheetCancel'),
  madmax: document.getElementById('madmax'),
  mmState: document.getElementById('mmState'),
  mmRules: document.getElementById('mmRules'),
  mmToggle: document.getElementById('mmToggle'),
  mmLog: document.getElementById('mmLog'),
  mmWires: document.getElementById('mmWires'),
  mmWirePush: document.getElementById('mmWirePush'),
  mmWirePoll: document.getElementById('mmWirePoll'),
  mmPushNote: document.getElementById('mmPushNote'),
  mmPollNote: document.getElementById('mmPollNote'),
  mmTallies: document.getElementById('mmTallies'),
  armBackdrop: document.getElementById('armBackdrop'),
  armRules: document.getElementById('armRules'),
  armWarn: document.getElementById('armWarn'),
  slideArm: document.getElementById('slideArm'),
  armSlider: document.getElementById('armSlider'),
  armFill: document.getElementById('armFill'),
  armLabel: document.getElementById('armLabel'),
  armCancel: document.getElementById('armCancel'),
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
let lastSavedWeek = null;
let weeklyHourCap = null;
let shiftBlocks = [];
let sheetDay = null;

const label = (day) => day[0].toUpperCase() + day.slice(1);
const listDays = (days) => days.map(label).join(', ');

// 480 -> "8am". Mirrors the server so a range reads the same on both sides.
function minsLabel(minutes) {
  const total = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(total / 60);
  const mins = total % 60;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? 'am' : 'pm';
  return mins ? `${hour12}:${String(mins).padStart(2, '0')}${suffix}` : `${hour12}${suffix}`;
}

function merge(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

// A day is 'off', 'all-day', or ranges. Everything compares on this string so
// the three forms are never checked by identity.
function describe(value) {
  if (!value || value === 'off') return 'off';
  if (value === 'all-day') return 'all-day';

  const ranges = merge(value);
  if (!ranges.length) return 'off';
  if (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= 1440) return 'all-day';
  return ranges.map(([from, to]) => `${minsLabel(from)}-${minsLabel(to)}`).join(', ');
}

const stateText = (value) => {
  const shape = describe(value);
  if (shape === 'off') return 'Off';
  if (shape === 'all-day') return 'All day';
  return shape;
};

const isDirty = () => DAYS.some((d) => describe(live[d]) !== describe(draft[d]));
const countOn = (week) => DAYS.filter((d) => describe(week[d]) !== 'off').length;

// Local YYYY-MM-DD. toISOString() would push an 8pm shift to the next day.
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

// Calendar days, not elapsed hours, so 8pm tomorrow reads as "tomorrow".
function relativeDay(iso) {
  const midnight = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const days = Math.round((midnight(iso) - midnight(new Date())) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return `in ${days} days`;
  const weeks = Math.round(days / 7);
  return `in ${weeks} week${weeks === 1 ? '' : 's'}`;
}

function relativeTime(iso) {
  const seconds = Math.round((Date.now() - new Date(iso)) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 90) return 'a minute ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
}

// Lead with what to do about it. The raw error stays underneath, quietly.
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
  const on = describe(draft[day]) !== 'off';

  const row = document.createElement('div');
  row.className = `row${on ? ' on' : ''}`;

  const name = document.createElement('span');
  name.className = 'day';
  name.textContent = label(day);

  // The state is the way in to picking times, so it is a control, not a label.
  const state = document.createElement('button');
  state.type = 'button';
  state.className = 'state';
  state.textContent = stateText(draft[day]);
  state.title = `Pick shifts for ${label(day)}`;
  state.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!busy) openSheet(day);
  });

  const wrap = document.createElement('label');
  wrap.className = 'switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = on;
  input.disabled = busy;
  input.setAttribute('aria-label', `${label(day)} availability`);
  // The switch is the coarse control: everything, or nothing. Times come from
  // the sheet.
  input.addEventListener('change', () => {
    draft[day] = input.checked ? 'all-day' : 'off';
    row.classList.toggle('on', input.checked);
    state.textContent = stateText(draft[day]);
    syncFooter();
  });

  const track = document.createElement('span');
  track.className = 'track';

  wrap.append(input, track);
  row.append(name, state, wrap);

  // The whole row is a target, which matters far more with a mouse than a thumb.
  row.addEventListener('click', (event) => {
    if (busy || event.target.closest('.switch')) return;
    input.click();
  });

  return row;
}

/* ---------- slot sheet ---------- */

const coveredBy = (block, ranges) =>
  ranges.some(([from, to]) => from <= block.from && to >= block.to);

function openSheet(day) {
  sheetDay = day;
  el.sheetTitle.textContent = label(day);

  const shape = describe(draft[day]);
  const ranges = shape === 'all-day'
    ? [[0, 1440]]
    : (Array.isArray(draft[day]) ? merge(draft[day]) : []);

  el.sheetBody.replaceChildren(...shiftBlocks.map((block) => {
    const row = document.createElement('label');
    row.className = 'slot';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.code = block.code;
    box.checked = coveredBy(block, ranges);

    const code = document.createElement('span');
    code.className = 'slot-code';
    code.textContent = block.code;

    const time = document.createElement('span');
    time.className = 'slot-time';
    time.textContent = `${minsLabel(block.from)} – ${minsLabel(block.to)}`;

    row.append(box, code, time);
    return row;
  }));

  el.backdrop.hidden = false;
  el.sheetOk.focus();
}

const closeSheet = () => {
  el.backdrop.hidden = true;
  sheetDay = null;
};

function applySheet() {
  if (!sheetDay) return;

  const picked = shiftBlocks.filter(
    (b) => el.sheetBody.querySelector(`input[data-code="${b.code}"]`)?.checked,
  );

  // All five is all day, which is what TeamWork stores as enabled with no slots.
  if (!picked.length) draft[sheetDay] = 'off';
  else if (picked.length === shiftBlocks.length) draft[sheetDay] = 'all-day';
  else draft[sheetDay] = merge(picked.map((b) => [b.from, b.to]));

  closeSheet();
  render();
}

el.sheetOk.addEventListener('click', applySheet);
el.sheetCancel.addEventListener('click', closeSheet);
el.backdrop.addEventListener('click', (event) => {
  if (event.target === el.backdrop) closeSheet();
});

document.addEventListener('keydown', (event) => {
  if (el.backdrop.hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeSheet(); }
  if (event.key === 'Enter') { event.preventDefault(); applySheet(); }
});

function syncFooter() {
  const dirty = isDirty();
  const pending = DAYS.filter((d) => live[d] !== draft[d]).length;
  el.save.className = 'save';
  el.save.disabled = !dirty;
  // Naming the count makes the button confirm the scope of a real schedule write.
  el.save.textContent = dirty
    ? `Save ${pending} change${pending === 1 ? '' : 's'}`
    : 'Saved';

  const n = countOn(draft);
  el.subtitle.textContent = n === 0
    ? 'Not available any day this week.'
    : `Available ${n} ${n === 1 ? 'day' : 'days'} a week, all day.`;

  // Toggling does not rebuild the calendar, so sync the headers where changes land.
  syncCalendarHeads();

  if (dirty) {
    const changed = DAYS.filter((d) => live[d] !== draft[d]);
    setStatus(`${listDays(changed)} not saved yet`);
  } else {
    setStatus(verifiedAt ? `Verified with TeamWork ${relativeTime(verifiedAt)}` : '');
  }
}

/* ---------- upcoming shifts ---------- */

let myShifts = [];
// Pay needs the wider set: a shift worked on Monday still counts this week.
let allShifts = [];
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
    // Still worth showing: zeros are the answer to "what am I earning".
    renderPay();
    return;
  }

  el.shifts.hidden = false;

  const hours = shifts.reduce((sum, s) => sum + (s.hours ?? 0), 0);
  el.shiftsSummary.textContent =
    `${shifts.length} ${shifts.length === 1 ? 'shift' : 'shifts'} · ${hours} hours`;

  renderCalendar(shifts);
  renderAgenda(shifts);
  renderAlerts();
  renderPay();
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
    // S and T each appear twice, so give assistive tech the real name.
    head.title = DAYS[i];
    head.dataset.day = DAYS[i];
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
    cell.dataset.date = key;
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
  syncCalendarHeads();
}

// Same seven weekdays as the toggles, so marking the offered ones saves
// cross-referencing two panels.
function syncCalendarHeads() {
  if (!draft) return;
  for (const head of el.cal.querySelectorAll('.cal-head')) {
    head.classList.toggle('avail', draft[head.dataset.day] === 'all-day');
  }
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
      const groupLabel = document.createElement('span');
      groupLabel.textContent = heading(offset);
      // Free information from data already on screen, and it matters near a cap.
      const groupHours = document.createElement('span');
      groupHours.className = 'group-hours';
      groupHours.textContent = `${hoursOf(shifts.filter((s) => weekOf(s.start) === offset))}h`;
      li.append(groupLabel, groupHours);
      items.push(li);
    }

    const start = new Date(shift.start);

    const li = document.createElement('li');
    // shifts is sorted soonest-first, so the first entry is the next one up.
    li.className = `agenda-item${shift === shifts[0] ? ' next' : ''}`;
    li.dataset.date = dateKey(start);

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
    place.append(stationEl(shift));

    // The question this screen gets asked most, answered without counting rows.
    if (shift === shifts[0]) {
      const soon = document.createElement('span');
      soon.className = 'soon';
      soon.textContent = relativeDay(shift.start);
      place.append(document.createTextNode(' · '), soon);
    }

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

const PIN = `<svg class="pin" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 21.2s6.6-6.1 6.6-10.6a6.6 6.6 0 1 0-13.2 0C5.4 15.1 12 21.2 12 21.2z"/>
  <circle cx="12" cy="10.4" r="2.4"/></svg>`;

// A bare underline was invisible, so the pin says "this goes somewhere".
function stationEl(shift) {
  if (!shift.station) return document.createTextNode('');
  if (!shift.mapUrl) return document.createTextNode(shift.station);

  const link = document.createElement('a');
  link.className = 'station';
  link.href = shift.mapUrl;
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = `Directions to ${shift.station}`;
  link.append(shift.station);
  link.insertAdjacentHTML('beforeend', PIN);
  return link;
}

// An overlap with a shift you already hold is a real clash, unlike availability.
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
  const clash = overlapsExisting(shift);
  const extras = [`${shift.hours}h`];
  if (shift.offeredTo) extras.push('offered to you');
  if (clash) extras.push('clashes with a shift you have');

  if (shift.station) place.append(stationEl(shift), document.createTextNode(' · '));
  place.append(document.createTextNode(extras.join(' · ')));
  if (clash) place.classList.add('clash');
  body.append(time, place);

  // The claim write has never been observed, and guessing at a request that
  // commits you to a shift is not acceptable. Hands off to TeamWork until then.
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

// Link health only. The board count is already answered by the panel below it.
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

// Polls while the page is open, background tab included, since that is when the
// notification matters. Closing the tab stops it; there is no daemon.
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

// One shift a week keeps the job, and availability resets weekly. Both are easy
// to forget and neither shows anywhere until it is too late.

const WEEK_MS = 604800000;

function weekStartOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

const hoursOf = (list) => list.reduce((sum, s) => sum + (s.hours ?? 0), 0);

const shiftPool = () => (allShifts.length ? allShifts : myShifts);

function shiftsInWeek(offset) {
  const start = weekStartOf(new Date()).getTime() + offset * WEEK_MS;
  return shiftPool().filter((s) => {
    const w = weekStartOf(new Date(s.start)).getTime();
    return w === start;
  });
}

// The calendar month, which feels like a pay period even though it is not one.
function shiftsInMonth() {
  const now = new Date();
  return shiftPool().filter((s) => {
    const d = new Date(s.start);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
}

// Days left until next week starts. Drives how loud the warning gets.
function daysUntilNextWeek() {
  const nextWeek = weekStartOf(new Date()).getTime() + WEEK_MS;
  return Math.ceil((nextWeek - Date.now()) / 86400000);
}

function readiness() {
  const alerts = [];

  // Every day off almost always means a reset, not "I cannot work at all".
  if (live && countOn(live) === 0) {
    alerts.push({
      level: 'warn',
      text: 'Availability is empty. Set your days and save.',
      // Useful only at this moment, so it exists only at this moment.
      action: lastSavedWeek ? { label: 'Use last saved', run: applyLastSaved } : null,
    });
  }

  // Say nothing until shifts land, rather than flash a false warning on load.
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

    // Going over a term-time cap is the sort of thing payroll notices first.
    if (weeklyHourCap) {
      for (const [offset, when] of [[0, 'this week'], [1, 'next week']]) {
        const hours = hoursOf(shiftsInWeek(offset));
        if (hours > weeklyHourCap) {
          alerts.push({
            level: 'bad',
            text: `${hours} hours ${when}, over your ${weeklyHourCap} hour cap.`,
          });
        }
      }
    }
  }

  return alerts;
}

// Load the last saved week into the toggles without submitting it. The user
// still reviews and presses Save, so a stale preset can never save itself.
function applyLastSaved() {
  if (!lastSavedWeek) return;
  draft = { ...lastSavedWeek };
  render();
  el.save.focus();
}

function renderAlerts() {
  const alerts = readiness();
  el.alerts.hidden = alerts.length === 0;
  el.alerts.replaceChildren(...alerts.map((a) => {
    const div = document.createElement('div');
    div.className = `alert ${a.level}`;
    const dot = document.createElement('i');
    const text = document.createElement('span');
    text.textContent = a.text;
    div.append(dot, text);

    if (a.action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'alert-action';
      button.textContent = a.action.label;
      button.addEventListener('click', a.action.run);
      div.append(button);
    }
    return div;
  }));
}

/* ---------- pay ---------- */

// Rates live in config.json. They are real-world assumptions, not code.
let payConfig = null;
let payVisible = false;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const money = (n) => new Intl.NumberFormat(undefined, {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
}).format(n);

// Whole shift billed by its start hour. A window crossing midnight is a union.
function isNightShift(shift) {
  const hour = new Date(shift.start).getHours();
  const { nightFrom, nightTo } = payConfig;
  return nightFrom < nightTo
    ? hour >= nightFrom && hour < nightTo
    : hour >= nightFrom || hour < nightTo;
}

function payFor(shifts) {
  let baseHours = 0;
  let nightHours = 0;
  for (const shift of shifts) {
    if (isNightShift(shift)) nightHours += shift.hours ?? 0;
    else baseHours += shift.hours ?? 0;
  }
  const gross = baseHours * payConfig.base + nightHours * payConfig.night;
  return {
    hours: baseHours + nightHours,
    gross,
    net: gross * (1 - (payConfig.taxRate ?? 0)),
  };
}

function payCell(className, value) {
  const span = document.createElement('span');
  span.className = className;
  // Real figure lives in the data attribute so the text can be blocked or rolled.
  span.dataset.value = value;
  return span;
}

function payTile(name, list) {
  const p = payFor(list);

  const tile = document.createElement('div');
  tile.className = 'pay-tile';

  const when = document.createElement('span');
  when.className = 'pay-when';
  when.textContent = name;

  // Take-home is the figure you actually receive, so it is the one set large.
  const take = payCell('pay-take mono', money(p.net));

  const detail = document.createElement('span');
  detail.className = 'pay-detail';
  const hours = document.createElement('span');
  hours.className = 'mono';
  hours.textContent = p.hours ? `${p.hours}h` : '0h';
  detail.append(hours, document.createTextNode(' · '));
  detail.append(payCell('pay-gross mono', money(p.gross)));
  detail.append(document.createTextNode(' gross'));

  tile.append(when, take, detail);
  return tile;
}

function renderPay() {
  if (!payConfig || !shiftsLoaded) return;
  el.pay.hidden = false;

  el.payRows.replaceChildren(
    payTile('This week', shiftsInWeek(0)),
    payTile('Next week', shiftsInWeek(1)),
    payTile(new Date().toLocaleDateString(undefined, { month: 'long' }), shiftsInMonth()),
  );

  const rate = Math.round((payConfig.taxRate ?? 0) * 100);
  el.payNote.textContent =
    `$${payConfig.base}/h · $${payConfig.night}/h nights · take-home est. after ${rate}%`;

  paintPay();
}

// Hiding is a CSS blur rather than substituted characters, so the layout never
// shifts and the number reads as private rather than missing.
function paintPay(animate = false) {
  for (const cell of el.payRows.querySelectorAll('[data-value]')) {
    const real = cell.dataset.value;
    clearInterval(cell.rollTimer);
    if (payVisible && animate && !reduceMotion) rollDigits(cell, real);
    else cell.textContent = real;
  }
}

// Digits tumble then settle, so the number reads as resolving, not appearing.
function rollDigits(cell, real) {
  const steps = 8;
  let step = 0;
  clearInterval(cell.rollTimer);
  cell.rollTimer = setInterval(() => {
    step += 1;
    if (step >= steps) {
      clearInterval(cell.rollTimer);
      cell.textContent = real;
      return;
    }
    cell.textContent = real.replace(/[0-9]/g, () => String(Math.floor(Math.random() * 10)));
  }, 45);
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
    // Reads as a diff. The long form wrapped to three lines on a full week.
    what.textContent = entry.changes
      .map((c) => `${c.after === 'all-day' ? '+' : '−'}${label(c.name).slice(0, 3)}`)
      .join('  ');

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
    weeklyHourCap = data.weeklyHourCap ?? null;
    payConfig = data.pay ?? null;
    shiftBlocks = data.shiftBlocks ?? [];
    render();
  } catch (err) {
    el.days.setAttribute('aria-busy', 'false');
    el.days.replaceChildren();
    el.subtitle.textContent = 'Could not reach TeamWork.';
    setLink('down');
    setStatus(humanize(err.message), 'error', err.message);
    return;
  }

  // Extras. Fetched after the week is on screen, and never fatal.
  api('/api/shifts')
    .then((data) => {
      allShifts = data.all ?? data.shifts;
      renderShifts(data.shifts);
    })
    .catch((err) => console.warn('shifts unavailable:', err.message));

  // Powers the "Use last saved" shortcut on an empty week.
  api('/api/last-week')
    .then((data) => { lastSavedWeek = data.week; renderAlerts(); })
    .catch((err) => console.warn('last week unavailable:', err.message));

  refreshHistory();
  checkOpenShifts();
  loadMadMax();
}

// The toggles are TeamWork's state, so a reset has to reach the page. Skipped
// while there are unsaved edits: clobbering a draft is worse than being stale.
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

// A dot on the calendar and its row in the agenda are the same shift, so make
// the grid a way to find it rather than a picture of it.
el.cal.addEventListener('click', (event) => {
  const cell = event.target.closest('.cal-day.has-shift');
  if (!cell) return;

  const row = el.agenda.querySelector(`.agenda-item[data-date="${cell.dataset.date}"]`);
  if (!row) return;

  row.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  row.classList.remove('flash');
  void row.offsetWidth; // restart the animation if the same day is clicked twice
  row.classList.add('flash');
});

// Manual trigger. The server also syncs on every shift refresh, so this is for
// when you want it now rather than within the minute.
el.syncCal.addEventListener('click', async () => {
  const previous = el.shiftsSummary.textContent;
  el.syncCal.classList.add('working');
  el.shiftsSummary.textContent = 'syncing…';

  try {
    const data = await api('/api/calendar/sync', { method: 'POST' });
    el.shiftsSummary.textContent = `${data.synced} in ${data.calendar}`;
  } catch (err) {
    el.shiftsSummary.textContent = 'sync failed';
    console.warn('calendar sync:', err.message);
  } finally {
    el.syncCal.classList.remove('working');
    setTimeout(() => { el.shiftsSummary.textContent = previous; }, 2600);
  }
});

el.payToggle.addEventListener('click', () => {
  payVisible = !payVisible;
  el.payToggle.setAttribute('aria-pressed', String(payVisible));
  el.payToggle.setAttribute('aria-label', payVisible ? 'Hide pay' : 'Show pay');
  el.pay.classList.toggle('revealed', payVisible);
  paintPay(payVisible);
});

/* ---------- mad max ---------- */

let mm = { armed: false, rules: {} };

const hoursOfMinutes = (mins) => `${Math.round(mins / 60)}h`;

const mmRuleText = (rules) => [
  rules.maxHoursPerWeek ? `${rules.maxHoursPerWeek}h/wk cap` : null,
  rules.minNoticeMinutes ? `${hoursOfMinutes(rules.minNoticeMinutes)} notice` : null,
  rules.minGapMinutes ? `${hoursOfMinutes(rules.minGapMinutes)} gap` : null,
  rules.skipOverlaps ? 'no overlaps' : null,
  rules.blackoutDates?.length ? `${rules.blackoutDates.length} blackout` : null,
].filter(Boolean).join(' · ');

// The push path is the one that can win a one-second race, so its state is
// spelled out rather than left to be inferred from whether claims happen.
const PUSH_STATE = {
  watching: ['live', 'watching'],
  reconnecting: ['warn', 'reconnecting'],
  unconfigured: ['off', 'not configured'],
  off: ['off', 'off'],
};

function renderWires() {
  const { armed, lastRun, lastCause, mail = {}, log = [] } = mm;
  el.mmWires.hidden = !armed;
  if (!armed) return;

  const [pushClass, pushLabel] = PUSH_STATE[mail.state] ?? PUSH_STATE.off;
  el.mmWirePush.className = `mm-wire ${pushClass}`;
  el.mmPushNote.textContent = mail.lastTrigger
    ? `${pushLabel} · fired ${relativeTime(mail.lastTrigger.at)}`
    : mail.lastMail
      ? `${pushLabel} · last mail ${relativeTime(mail.lastMail.at)}`
      : pushLabel;

  // Naming the cause matters: a sweep that ran because mail arrived is the fast
  // path working, and one that ran on the clock is only the safety net.
  el.mmWirePoll.className = 'mm-wire live';
  el.mmPollNote.textContent = lastRun
    ? `${relativeTime(lastRun)}${lastCause && lastCause !== 'poll' ? ` · via ${lastCause.split(':')[0]}` : ''}`
    : 'idle';

  const tally = (kind) => log.filter((e) => e.kind === kind).length;
  const counts = [
    `${tally('claimed')} claimed`,
    `${tally('failed')} lost`,
    `${tally('skipped')} skipped`,
  ].join(' · ');

  // A gap outranks the counts. Closing the lid suspends the whole thing, and
  // "swept just now" after waking would claim coverage that never happened.
  // Losing the wake assertion outranks even that, because then every future
  // sweep is in doubt rather than one past window.
  const gap = mm.lastGap;
  const warn = !mm.awake || Boolean(gap);
  el.mmTallies.classList.toggle('warn', warn);

  el.mmTallies.textContent = !mm.awake
    ? `this Mac can sleep, so it will stop looking · ${counts}`
    : gap
      ? `asleep ${gap.minutes} min, missed anything posted then · ${counts}`
      : counts;
}

function renderMadMax() {
  const { armed, lastRun, intervalMs, rules, log = [] } = mm;

  el.madmax.classList.toggle('armed', armed);
  el.mmToggle.textContent = armed ? 'DISARM' : 'ARM';
  el.mmToggle.className = `mm-btn${armed ? ' live' : ''}`;
  el.mmRules.textContent = mmRuleText(rules);

  // Rounding turned a 1.5s sweep into "2s", which misreports the setting.
  const seconds = (intervalMs ?? 45000) / 1000;
  const every = Number.isInteger(seconds) ? seconds : seconds.toFixed(1);

  el.mmState.textContent = armed
    ? `ARMED · every ${every}s${lastRun ? ` · swept ${relativeTime(lastRun)}` : ''}`
    : 'disarmed';

  renderWires();

  el.mmLog.hidden = !armed || !log.length;
  el.mmLog.replaceChildren(...log.slice(0, 8).map((event) => {
    const li = document.createElement('li');
    li.className = `mm-line ${event.kind}`;

    const when = document.createElement('span');
    when.className = 'mm-when';
    when.textContent = new Date(event.at).toLocaleTimeString(undefined, { hour12: false });

    const kind = document.createElement('span');
    kind.className = 'mm-kind';
    kind.textContent = event.kind;

    const what = document.createElement('span');
    what.className = 'mm-what';
    what.textContent = [event.station, event.why].filter(Boolean).join(' · ');

    li.append(when, kind, what);
    return li;
  }));
}

async function loadMadMax() {
  try {
    mm = await api('/api/madmax');
    renderMadMax();
  } catch (err) {
    console.warn('madmax state unavailable:', err.message);
  }
}

function openArmSheet() {
  el.armRules.replaceChildren(...[
    mm.rules.maxHoursPerWeek && `will not pass ${mm.rules.maxHoursPerWeek}h in any week`,
    mm.rules.minNoticeMinutes && `ignores shifts starting within ${hoursOfMinutes(mm.rules.minNoticeMinutes)}`,
    mm.rules.skipOverlaps && 'never takes a shift overlapping one you hold',
    mm.rules.minGapMinutes && `keeps ${hoursOfMinutes(mm.rules.minGapMinutes)} clear of shifts you hold, so no back-to-back`,
    mm.rules.blackoutDates?.length
      ? `skips ${mm.rules.blackoutDates.length} blacked-out date(s)`
      : 'no blackout dates set',
    'disarms itself if the server restarts',
  ].filter(Boolean).map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));

  // Said in the product, not just the README, and it has to track what the
  // server will actually do. This text used to promise that claiming was not
  // wired up long after it was, which is the worst possible thing for a
  // confirmation dialog to be wrong about.
  el.armWarn.textContent = mm.rules?.checkOnly
    ? 'Check-only: it will find shifts and ask the server whether it could take them, '
      + 'but it will not take them. Nothing gets claimed and nothing is committed.'
    : 'This claims real shifts on your behalf, and a claim commits you to the work. '
      + 'The claim request was reconstructed from TeamWork’s own client and has never been '
      + 'confirmed against a live shift, so watch the first one.';

  resetSlider();
  el.armBackdrop.hidden = false;
  el.armSlider.focus();
}

// Must reach the far end. Anything short snaps back, so a half-hearted drag is
// the same as not doing it.
const SLIDE_ARMED_AT = 97;

function resetSlider() {
  el.armSlider.value = 0;
  el.armFill.style.width = '0%';
  el.armLabel.style.opacity = '1';
  el.slideArm.classList.remove('ready');
}

const closeArmSheet = () => {
  el.armBackdrop.hidden = true;
  resetSlider();
};

async function setArmed(armed) {
  try {
    mm = await api('/api/madmax', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ armed }),
    });
    renderMadMax();
  } catch (err) {
    console.warn('madmax toggle failed:', err.message);
  }
}

el.mmToggle.addEventListener('click', () => {
  if (mm.armed) setArmed(false);
  else openArmSheet();
});

el.armSlider.addEventListener('input', () => {
  const at = Number(el.armSlider.value);
  el.armFill.style.width = `${at}%`;
  // The label fades out as the knob covers it rather than sitting underneath.
  el.armLabel.style.opacity = String(Math.max(0, 1 - at / 45));
  el.slideArm.classList.toggle('ready', at >= SLIDE_ARMED_AT);
});

// Fires on release, so a drag that stops short resets instead of arming.
el.armSlider.addEventListener('change', () => {
  if (Number(el.armSlider.value) < SLIDE_ARMED_AT) return resetSlider();
  closeArmSheet();
  setArmed(true);
});

el.armCancel.addEventListener('click', closeArmSheet);
el.armBackdrop.addEventListener('click', (event) => {
  if (event.target === el.armBackdrop) closeArmSheet();
});

// While armed the panel is live state, so keep it moving.
setInterval(() => { if (mm.armed) loadMadMax(); }, 15000);

/* ---------- appearance ---------- */

// Three states, not two. Auto must stay reachable once you have overridden it.
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

  // Bare keys, never while typing. A checkbox is not typing, which matters
  // because 1-7 should still work with a day toggle focused.
  const target = event.target;
  const typing = target.isContentEditable
    || target.tagName === 'TEXTAREA'
    || (target.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(target.type));
  if (meta || event.altKey || typing) return;

  if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    el.refresh.click();
    return;
  }

  // 1-7 toggle Sunday through Saturday, matching the on-screen order.
  const digit = Number(event.key);
  if (Number.isInteger(digit) && digit >= 1 && digit <= 7) {
    event.preventDefault();
    const name = DAYS[digit - 1];
    el.days.querySelector(`input[aria-label="${label(name)} availability"]`)?.click();
  }
});

/* ---------- sticky header rule ---------- */

const onScroll = () => el.topbar.classList.toggle('scrolled', window.scrollY > 4);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();
