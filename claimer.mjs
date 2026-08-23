// Email in, one board read, one claim out.
//
// The old claimer polled the swapboard to find shifts, which is what earned a 30
// minute lockout and never took a shift. This one never polls. An alert mail says
// a shift exists and names it exactly, so the board is read once, for the single
// date in the mail, only to turn that description into the `Id` and `LocId` that
// `quick-claim` needs.
//
// Two things it must never do, in order of how much they would cost:
//
//   1. Claim a shift other than the one the email described. The board read can
//      come back with several rows and a claim commits Amey to real work, so a
//      row is only claimable if it matches on time and station, and an ambiguous
//      board is a refusal rather than a guess.
//   2. Claim a shift that breaks his own rules. There is no planner here because
//      an email is one shift, not a board, but the weekly cap still has to hold
//      across two alerts arriving a second apart.

import { parseAlert } from './alert.mjs';

const MINUTE = 60000;
const DAY = 86400000;

// A claim confirmed by TeamWork is not visible in the schedule read for a while,
// because that is served from a five minute cache. Without remembering it, two
// alerts in the same minute both see a week with room for one more shift.
const CLAIM_MEMORY_MS = 15 * MINUTE;

const at = (iso) => new Date(iso).getTime();

const weekStart = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
};

// Whole minutes on both sides. Comparing decimal hours let a shift that exactly
// filled the week round its way over the cap.
const toMinutes = (hours) => Math.round(Math.max(0, Number(hours) || 0) * 60);
const asHours = (minutes) => Number((minutes / 60).toFixed(2));

// A held shift whose dates will not parse is more dangerous than one we do not
// know about: NaN comparisons are all false, so it silently passes every guard
// and drops its hours out of the week total.
const readable = (s) => typeof s?.start === 'string' && typeof s?.end === 'string'
  && Number.isFinite(at(s.start)) && Number.isFinite(at(s.end))
  && Number.isFinite(Number(s.hours)) && Number(s.hours) > 0;

const overlaps = (a, b) => at(a.start) < at(b.end) && at(b.start) < at(a.end);

// Clear air between two shifts. 0 when they touch or overlap.
const gapBetween = (a, b) => Math.max(0, at(a.start) >= at(b.start)
  ? at(a.start) - at(b.end)
  : at(b.start) - at(a.end));

const minutesInWeek = (shifts, when) => shifts
  .filter((s) => weekStart(at(s.start)) === weekStart(when))
  .reduce((sum, s) => sum + toMinutes(s.hours), 0);

/* ---------- matching ---------- */

// Turns the email's description into the actual board row, or refuses.
//
// Time is the anchor, not the station name. The email writes a station as
// "Hamper Station Duty" and the board has its own idea of what that field
// contains, so an exact station match is preferred but a single row at exactly
// the right start and end is accepted on its own. Two rows at the same time with
// neither matching the station is genuinely ambiguous and gets refused.
export function matchShift(board, wanted) {
  const claimable = (board ?? []).filter((row) => row?.id != null && row.start && row.end);

  const sameTime = claimable.filter(
    (row) => at(row.start) === at(wanted.start) && at(row.end) === at(wanted.end),
  );

  if (!sameTime.length) {
    return {
      row: null,
      why: `nothing on the board at ${wanted.start} to ${wanted.end}`
        + ` (${claimable.length} row${claimable.length === 1 ? '' : 's'} that day)`,
    };
  }

  const exact = sameTime.filter((row) => row.station === wanted.station);
  if (exact.length === 1) return { row: exact[0], why: 'matched on time and station' };

  if (exact.length > 1) {
    // Two identical postings. Either satisfies the email, so take the first
    // rather than refusing a shift that is genuinely available twice.
    return { row: exact[0], why: `${exact.length} identical rows, taking the first` };
  }

  if (sameTime.length === 1) {
    return {
      row: sameTime[0],
      why: `matched on time only, station reads "${sameTime[0].station}" not "${wanted.station}"`,
    };
  }

  return {
    row: null,
    why: `${sameTime.length} rows at that time and none at station "${wanted.station}", too ambiguous to claim`,
  };
}

/* ---------- rules ---------- */

// The rules that need nothing but the shift's own description: how long it is,
// when it starts, what day it falls on. Split out because the alert email carries
// all three, so a shift that fails here can be refused without reading the board
// at all. One definition, called from both the pre-screen and judge().
export function screenByDescription(shift, { config = {}, now = Date.now() } = {}) {
  const {
    // How far out the shift has to start. Measured across the 56 captured
    // alerts: 180 keeps 48 of them and skips 8, and every one of those 8 was
    // genuinely short notice (60, 68, 72, 79, 117, 118, 119 and 138 minutes).
    // 120 would keep one more. There is no duration rule here on purpose: every
    // real shift was 4h, 4.25h, 4.5h or 8h, so a minimum length could never fire.
    minNoticeMinutes = 180,
    blackoutDates = [],
  } = config;

  const day = shift.start.slice(0, 10);
  if (blackoutDates.includes(day)) return { take: false, why: `${day} is blacked out` };

  if (at(shift.start) - now < minNoticeMinutes * MINUTE) {
    const mins = Math.round((at(shift.start) - now) / MINUTE);
    return { take: false, why: `starts in ${mins} min, under the ${minNoticeMinutes} min notice I want` };
  }

  return { take: true, why: 'clear' };
}

// One shift, one verdict, with the reason spelled out. Cheapest and most
// absolute checks first.
export function judge(shift, { mine: rawMine = [], config = {}, now = Date.now() } = {}) {
  const {
    maxHoursPerWeek = null,
    minGapMinutes = 0,
    skipOverlaps = true,
  } = config;

  const mine = rawMine.filter(readable);

  if (!readable(shift)) {
    return { take: false, why: `unusable times or hours (${shift?.start} to ${shift?.end}, ${shift?.hours}h)` };
  }

  if (shift.id == null) return { take: false, why: 'no shift id, so nothing to claim' };

  // Not every row is a one-click take. A bid is awarded by a manager later and a
  // trade costs a shift in return, so firing a claim at either is wrong however
  // fast we are.
  if (shift.mode && shift.mode !== 'claim') {
    return { take: false, why: `not a one-click claim (${shift.mode})` };
  }

  // Re-run against the real row, not just the email's description of it. The
  // board is the authority on the times, and the pre-screen ran against what the
  // mail claimed they were.
  const described = screenByDescription(shift, { config, now });
  if (!described.take) return described;

  if (skipOverlaps && mine.some((held) => overlaps(shift, held))) {
    return { take: false, why: 'overlaps a shift already held' };
  }

  // Back to back is legal and still a sixteen hour day, which is a different
  // problem from overlapping.
  if (minGapMinutes) {
    const tooClose = mine.find((held) => gapBetween(shift, held) < minGapMinutes * MINUTE);
    if (tooClose) {
      return { take: false, why: `under ${minGapMinutes} min from the shift on ${tooClose.start.slice(0, 10)}` };
    }
  }

  // `!= null` so a cap of 0 means a cap of zero. Falsy here would read as "no
  // cap", and setting it to 0 as a kill switch would do the opposite of stopping
  // anything.
  if (maxHoursPerWeek != null) {
    const after = minutesInWeek(mine, at(shift.start)) + toMinutes(shift.hours);
    if (after > toMinutes(maxHoursPerWeek)) {
      return { take: false, why: `${asHours(after)}h would pass the ${maxHoursPerWeek}h weekly cap` };
    }
  }

  return { take: true, why: 'clear' };
}

/* ---------- the claimer ---------- */

export function createClaimer({
  loadBoard,
  loadMine,
  claim,
  check,
  config = {},
  // Asked at the moment a mail lands, not read once at construction, so the
  // switch takes effect on the next alert rather than the next restart.
  isPaused = () => false,
  onEvent,
  now = () => Date.now(),
} = {}) {
  let claimed = [];
  let handling = 0;
  const log = [];

  const record = (entry) => {
    const event = { at: new Date(now()).toISOString(), ...entry };
    log.unshift(event);
    log.length = Math.min(log.length, 50);
    onEvent?.(event);
    return event;
  };

  const remember = (shift) => {
    claimed = [
      ...claimed.filter((c) => c.rememberedAt > now() - CLAIM_MEMORY_MS),
      { shift, rememberedAt: now() },
    ];
  };

  // What the server says I hold, plus what this process took a moment ago and
  // the server has not caught up on.
  const everythingHeld = (mine) => {
    const known = new Set(mine.map((s) => s.id));
    return [
      ...mine,
      ...claimed
        .filter((c) => c.rememberedAt > now() - CLAIM_MEMORY_MS && !known.has(c.shift.id))
        .map((c) => c.shift),
    ];
  };

  // One alert, start to finish. Sequential on purpose: the board read has to
  // finish before the claim, and there is nothing to parallelise with one shift.
  async function onMail(mail) {
    const { shift: wanted, ignored } = parseAlert(mail);

    // Before the board read and before anything else, because switched off has
    // to mean no requests at all, not merely no claims. Logged so the alert that
    // arrived while it was off is still on the record.
    if (isPaused()) {
      const label = wanted ? `${wanted.station} ${wanted.start}` : (mail?.subject ?? 'a mail');
      record({ kind: 'paused', station: wanted?.station ?? null, start: wanted?.start ?? null, why: `switched off, ignored ${label}` });
      return { claimed: false, why: 'claimer is switched off' };
    }

    if (ignored) {
      // Logged rather than dropped. "A shift was posted and nothing happened" has
      // to be answerable, and most of the time the answer will be in here.
      record({ kind: 'ignored', why: ignored, subject: mail?.subject ?? null });
      return { claimed: false, why: ignored };
    }

    const started = now();
    handling += 1;
    record({
      kind: 'alert',
      station: wanted.station,
      start: wanted.start,
      hours: wanted.hours,
      why: `${wanted.location}, released by ${wanted.releasedBy ?? 'someone'}`,
    });

    // Before the board read, because the mail already says how long the shift is
    // and when it starts. A shift under the minimum should cost zero requests at
    // the one endpoint that rate limits, not one.
    const screened = screenByDescription(wanted, { config, now: now() });
    if (!screened.take) {
      record({
        kind: 'skipped', station: wanted.station, start: wanted.start, why: `${screened.why} (no board read)`,
      });
      handling -= 1;
      return { claimed: false, why: screened.why };
    }

    try {
      // One request, aimed at the one date the email named. This is the only
      // rate-limited endpoint the whole feature touches.
      const [board, mine] = await Promise.all([loadBoard(wanted.date), loadMine()]);

      const { row, why: matchWhy } = matchShift(board, wanted);
      if (!row) {
        // Almost always means somebody else claimed it between the mail being
        // sent and us reading the board. That is a lost race, not a fault.
        record({ kind: 'gone', station: wanted.station, start: wanted.start, why: matchWhy });
        return { claimed: false, why: matchWhy };
      }

      const verdict = judge(row, { mine: everythingHeld(mine), config, now: now() });
      if (!verdict.take) {
        record({
          kind: 'skipped', shift: row.id, station: row.station, start: row.start, why: verdict.why,
        });
        return { claimed: false, why: verdict.why };
      }

      if (config.checkOnly) {
        const answer = await check(row);
        record({
          kind: 'checked',
          shift: row.id,
          station: row.station,
          start: row.start,
          why: `server says canSwap=${answer.canSwap}`
            + `${answer.approvalRequired ? ', approval required' : ''}`
            + `, ${matchWhy}`,
        });
        return { claimed: false, why: 'checkOnly' };
      }

      const result = await claim(row);
      remember(row);
      record({
        kind: 'claimed',
        shift: row.id,
        station: row.station,
        start: row.start,
        hours: row.hours,
        // End to end, mail in hand to claim accepted. The only number that says
        // whether this design is fast enough to win.
        why: `${now() - started}ms from the alert, ${matchWhy}`
          + `${result?.warm === false ? ', on a cold socket' : ''}`,
      });
      return { claimed: true, shift: row };
    } catch (err) {
      record({ kind: 'error', station: wanted.station, start: wanted.start, why: err.message });
      return { claimed: false, why: err.message };
    } finally {
      handling -= 1;
    }
  }

  return {
    onMail,

    get state() {
      return {
        rules: config,
        handling,
        recentlyClaimed: claimed
          .filter((c) => c.rememberedAt > now() - CLAIM_MEMORY_MS)
          .map((c) => ({ id: c.shift.id, station: c.shift.station, start: c.shift.start })),
        log: log.slice(0, 12),
      };
    },
  };
}

export { DAY };
