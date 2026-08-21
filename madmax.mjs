// Mad Max mode: arm it and it takes shifts off the board without asking.
//
// The guardrails are not optional decoration. A bot that commits you to work
// needs to be unable to commit you to the wrong work, so every rejection is
// recorded with its reason and every claim is logged.

const MINUTE = 60000;

// The swapboard detail endpoint answers 400 "Please wait [1.5] seconds" if
// called faster, so sweeping below a second buys no earlier detection and only
// adds traffic. Raise it if that ever stops being true.
const MIN_INTERVAL_MS = 1000;

const weekStart = (at) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
};

const overlaps = (a, b) =>
  new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);

// Milliseconds of clear air between two shifts, 0 when they touch or overlap.
const gapBetween = (a, b) => Math.max(0, a.at >= b.at
  ? new Date(a.start) - new Date(b.end)
  : new Date(b.start) - new Date(a.end));

const hoursIn = (shifts, at) => shifts
  .filter((s) => weekStart(s.at) === weekStart(at))
  .reduce((sum, s) => sum + (s.hours ?? 0), 0);

// One shift, one verdict, with the reason spelled out. Order matters: the
// cheapest and most absolute checks run first.
export function judge(shift, { mine = [], config = {}, now = Date.now() } = {}) {
  const {
    maxHoursPerWeek = null,
    minNoticeMinutes = 0,
    minGapMinutes = 0,
    skipOverlaps = true,
    blackoutDates = [],
  } = config;

  const day = shift.start.slice(0, 10);

  if (blackoutDates.includes(day)) return { take: false, why: `${day} is blacked out` };

  if (shift.at - now < minNoticeMinutes * MINUTE) {
    return { take: false, why: `starts in under ${minNoticeMinutes} min` };
  }

  if (skipOverlaps && mine.some((held) => overlaps(shift, held))) {
    return { take: false, why: 'overlaps a shift already held' };
  }

  // Back-to-back is not the same problem as overlapping. A shift ending as
  // another begins is legal and still a 16 hour day.
  if (minGapMinutes) {
    const tooClose = mine.find((held) => gapBetween(shift, held) < minGapMinutes * MINUTE);
    if (tooClose) {
      return { take: false, why: `under ${minGapMinutes} min from a shift on ${tooClose.start.slice(0, 10)}` };
    }
  }

  if (maxHoursPerWeek) {
    const already = hoursIn(mine, shift.at);
    const after = already + (shift.hours ?? 0);
    if (after > maxHoursPerWeek) {
      return { take: false, why: `${after}h would pass the ${maxHoursPerWeek}h cap` };
    }
  }

  return { take: true, why: 'clear' };
}

// Judges the whole board, accumulating accepted shifts into `mine` so two
// candidates in the same week cannot both slip under the cap.
export function judgeBoard(board, { mine = [], config = {}, now = Date.now() } = {}) {
  const held = [...mine];

  return board
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((shift) => {
      const verdict = judge(shift, { mine: held, config, now });
      if (verdict.take) held.push(shift);
      return { shift, ...verdict };
    });
}

// Arming is deliberately in memory only. Restarting the server disarms, so a
// bot can never outlive the process that was told to run it.
export function createMadMax({ config, loadBoard, loadMine, claim, onEvent, intervalMs = 45000 }) {
  if (intervalMs < MIN_INTERVAL_MS) {
    console.warn(`madmax: ${intervalMs}ms sweep clamped to ${MIN_INTERVAL_MS}ms`);
    intervalMs = MIN_INTERVAL_MS;
  }

  let armed = false;
  let timer = null;
  let lastRun = null;
  const log = [];

  const record = (entry) => {
    const event = { at: new Date().toISOString(), ...entry };
    log.unshift(event);
    log.length = Math.min(log.length, 50);
    onEvent?.(event);
    return event;
  };

  async function sweep() {
    if (!armed) return;
    lastRun = new Date().toISOString();

    try {
      const [board, mine] = await Promise.all([loadBoard(), loadMine()]);
      if (!board.length) return;

      for (const { shift, take, why } of judgeBoard(board, { mine, config })) {
        if (!take) {
          record({ kind: 'skipped', shift: shift.id, station: shift.station, start: shift.start, why });
          continue;
        }

        try {
          await claim(shift);
          record({ kind: 'claimed', shift: shift.id, station: shift.station, start: shift.start, hours: shift.hours });
        } catch (err) {
          record({ kind: 'failed', shift: shift.id, station: shift.station, start: shift.start, why: err.message });
        }
      }
    } catch (err) {
      record({ kind: 'error', why: err.message });
    }
  }

  return {
    get state() {
      return { armed, lastRun, intervalMs, log: log.slice(0, 12) };
    },
    arm() {
      if (armed) return this.state;
      armed = true;
      record({ kind: 'armed' });
      timer = setInterval(sweep, intervalMs);
      sweep();
      return this.state;
    },
    disarm() {
      if (!armed) return this.state;
      armed = false;
      clearInterval(timer);
      timer = null;
      record({ kind: 'disarmed' });
      return this.state;
    },
  };
}
