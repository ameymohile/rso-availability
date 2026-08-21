// Mad Max mode: arm it and it takes shifts off the board without asking.
//
// The guardrails are not optional decoration. A bot that commits you to work
// needs to be unable to commit you to the wrong work, so every rejection is
// recorded with its reason and every claim is logged.

const MINUTE = 60000;

// This number is no longer a guess. Their own SwapBoard refuses to re-read the
// counts endpoint inside 30 seconds:
//
//   if (lastCountRefresh != null && secondsSince(lastCountRefresh) < 30) return;
//       -- countData(), emp/sch-swapboard.js
//
// So 30s is the rate the real board polls at, and matching it is the strongest
// defence against being flagged. Below it are two server limits: "Please wait
// [1.5] seconds" on the detail endpoint, and "Swap list disabled. (30) minutes
// idle required for reset.", which revokes board access until nothing has asked
// for 30 straight minutes. Sweeping at 1s tripped the second one.
const MIN_INTERVAL_MS = 30000;

// Retrying while locked out resets the idle timer, so this must stop the sweep
// rather than back off. "locked out" is here because the breaker raises its own
// message once it has tripped, and without it a re-arm during the cooldown kept
// sweeping: the bot never recognised the refusal it had caused itself.
const LOCKOUT = /disabled|idle required|locked out/i;

const DAY = 86400000;

// How many times a sweep will re-plan around lost races before it stops. Each
// round costs a round trip per claim, and the pool strictly shrinks, so this is
// a bound on time rather than on correctness.
const MAX_ROUNDS = 3;

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

// Hours arrive as decimals, so every cap comparison happens in whole minutes and
// both sides round identically. Rounding the candidate but not the room made the
// planner refuse a shift that exactly filled the week while judge() accepted it.
// The clamp at 0 is what stops a negative hours value buying cap room.
const toMinutes = (hours) => Math.round(Math.max(0, Number(hours) || 0) * 60);
const asHours = (minutes) => Number((minutes / 60).toFixed(2));

const minutesIn = (shifts, at) => shifts
  .filter((s) => weekStart(s.at) === weekStart(at))
  .reduce((sum, s) => sum + toMinutes(s.hours), 0);

const hoursIn = (shifts, at) => asHours(minutesIn(shifts, at));

// A held shift we cannot read is more dangerous than one we do not have: NaN
// date arithmetic makes every overlap and gap comparison false and drops its
// hours out of the week total, so all three guards pass at once. Zero-length
// rows are the day-off markers the schedule read returns, and keeping them
// blanks the gap rule either side of midnight while blaming "a shift".
const readable = (s) => typeof s?.start === 'string' && typeof s?.end === 'string'
  && Number.isFinite(new Date(s.start).getTime())
  && Number.isFinite(new Date(s.end).getTime())
  && Number.isFinite(Number(s.hours)) && Number(s.hours) > 0;

const usableHeld = (shifts, warn = false) => shifts.filter((s) => {
  if (readable(s)) return true;
  if (warn) console.warn(`madmax: ignoring an unreadable held shift (${JSON.stringify(s?.start)}..${JSON.stringify(s?.end)}, hours ${JSON.stringify(s?.hours)})`);
  return false;
});

// One shift, one verdict, with the reason spelled out. Order matters: the
// cheapest and most absolute checks run first.
export function judge(shift, { mine: rawMine = [], config = {}, now = Date.now() } = {}) {
  const mine = usableHeld(rawMine);
  const {
    maxHoursPerWeek = null,
    minNoticeMinutes = 0,
    minGapMinutes = 0,
    skipOverlaps = true,
    blackoutDates = [],
    horizonDays = 90,
  } = config;

  // A shift whose times will not parse cannot be judged at all. Refusing it out
  // loud beats the alternative: the date arithmetic goes NaN, every comparison
  // against it quietly returns false, and the shift vanishes with no reason
  // given. Found by a fuzz case that generated an hour of 25.
  //
  // The typeof checks matter as much as the parse: `new Date(null)` is 0 and
  // finite, so a null start got past the old guard and then threw on
  // shift.start.slice(), killing the whole plan instead of rejecting one row.
  if (typeof shift.start !== 'string' || typeof shift.end !== 'string'
    || !Number.isFinite(new Date(shift.start).getTime())
    || !Number.isFinite(new Date(shift.end).getTime())) {
    return { take: false, why: `unparseable times (${JSON.stringify(shift.start)} to ${JSON.stringify(shift.end)})` };
  }

  if (!Number.isFinite(Number(shift.hours)) || Number(shift.hours) <= 0) {
    return { take: false, why: `implausible hours (${JSON.stringify(shift.hours)})` };
  }

  // The claim is addressed by id, so a row without one is unclaimable. Rows with
  // no id also all collapse to the same key, which used to let several of them
  // through as one selection.
  if (shift.id == null) return { take: false, why: 'no shift id' };

  // The board reaches about 84 days out; the schedule read that fills `mine`
  // covers less. Past the end of `mine`, hoursIn() returns 0 and every rule that
  // consults it silently passes: the week looks empty, nothing can overlap, and
  // the full cap looks free. A shift we cannot check is one we must not take.
  if (shift.at - now > horizonDays * DAY) {
    return { take: false, why: `${Math.round((shift.at - now) / DAY)} days out, past the ${horizonDays}-day horizon I can verify` };
  }

  const day = shift.start.slice(0, 10);

  // Not every row on the board is a race. A bid is awarded by a manager later
  // and a trade costs a shift in return, so firing a claim at either is wrong
  // no matter how fast we are. Absent on shifts that predate the field.
  if (shift.mode && shift.mode !== 'claim') {
    return { take: false, why: `not a one-click claim (${shift.mode})` };
  }

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

  // `!= null`, so a cap of 0 means a cap of zero. It used to be falsy here and
  // therefore "no cap", while the planner read it as "take nothing" -- setting it
  // to 0 as a kill switch did the opposite of stopping anything.
  if (maxHoursPerWeek != null) {
    const after = minutesIn(mine, shift.at) + toMinutes(shift.hours);
    if (after > toMinutes(maxHoursPerWeek)) {
      return { take: false, why: `${asHours(after)}h would pass the ${maxHoursPerWeek}h cap` };
    }
  }

  return { take: true, why: 'clear' };
}

// What a shift is worth taking. Hours by default, which makes the optimiser
// maximise paid time. stationWeights lets a preferred post outrank raw hours:
// {"West Village H": 1.2} makes an hour there worth 1.2 of an hour elsewhere.
const valueOf = (shift, config) =>
  (shift.hours ?? 0) * (config.stationWeights?.[shift.station] ?? 1);

// The per-shift rules, with the weekly cap taken out. Whether a shift fits
// under the cap depends on which *other* shifts get taken, so that is the
// optimiser's job and not a property of the shift on its own. judge() stays the
// single definition of every other rule.
const screen = (shift, ctx) =>
  judge(shift, { ...ctx, config: { ...ctx.config, maxHoursPerWeek: null } });

// Two candidates can both be taken if the later one starts far enough after the
// earlier one ends. A gap of 0 degenerates to "must not overlap".
const fits = (earlier, later, minGapMinutes) =>
  new Date(later.start) - new Date(earlier.end) >= Math.max(0, minGapMinutes) * MINUTE;

// Above this the exact search is abandoned for the greedy pass. Cost grows about
// n^4 with minute-granular durations, not the flat curve the old limit of 120
// assumed: measured 1.6s at n=50, 9.2s at n=80 and 35s at n=120. The search is
// synchronous and shares the process with the HTTP server, so n=120 stalled
// everything for longer than the sweep interval. Real boards run under 25ms, so
// 40 is far above anything seen and well below the cliff.
const EXACT_LIMIT = 40;

// Picks the best combination of shifts rather than the first that fits.
//
// Taking shifts greedily in date order loses hours, and not marginally: with
// 14h of room and an 8h, a 7h and a 7h on the board, greedy takes the 8 and
// then neither 7 fits, so it banks 8h where 14h was available. The choice is a
// weighted interval scheduling problem with a per-week capacity on top, so it
// gets solved as one.
//
// Sorted by start, the state that matters is (how far we have got, which shift
// we took last, how much of this week we have spent). The last-taken index
// gives both the earliest legal next start and the current week, because takes
// only ever move forward, so the week never needs to be carried separately.
// Memoisation is sparse: the reachable spends are subset sums of one week's
// durations, not every value up to the cap.
export function planBoard(board, { mine: rawMine = [], config = {}, now = Date.now() } = {}) {
  const { minGapMinutes = 0, maxHoursPerWeek = null } = config;
  const mine = usableHeld(rawMine, true);

  const screened = board.map((shift) => {
    // The cap counts the hours field; gap and overlap count real timestamps.
    // Breaks and DST transitions make those disagree and nothing else notices.
    if (readable(shift)) {
      const clock = (new Date(shift.end) - new Date(shift.start)) / MINUTE;
      if (Math.abs(clock - toMinutes(shift.hours)) > 60) {
        console.warn(`madmax: shift ${shift.id} says ${shift.hours}h but spans ${asHours(clock)}h`);
      }
    }
    return { shift, verdict: screen(shift, { mine, config, now }) };
  });
  const rejected = screened.filter((s) => !s.verdict.take);

  // One row per id reaches the search. The claim is addressed by id, so two
  // selected rows sharing one would fire two PUTs at a single shift.
  const byId = new Map();
  const duplicates = [];
  for (const { shift } of screened.filter((s) => s.verdict.take).sort((a, b) => a.shift.at - b.shift.at)) {
    if (byId.has(shift.id)) duplicates.push(shift);
    else byId.set(shift.id, shift);
  }
  const candidates = [...byId.values()];

  // Minutes still available in each week after what is already held.
  const capMinutes = maxHoursPerWeek == null ? Infinity : toMinutes(maxHoursPerWeek);
  const roomIn = (at) => (capMinutes === Infinity
    ? Infinity
    : Math.max(0, capMinutes - minutesIn(mine, at)));

  const minutesOf = (shift) => toMinutes(shift.hours);
  const n = candidates.length;

  let chosen;
  if (n > EXACT_LIMIT) {
    console.warn(`madmax: ${n} candidates is over the exact limit, falling back to greedy`);
    chosen = greedyPick(candidates, { mine, config, now });
  } else {
    // best(i, last, spent) -> { value, take } for candidates i..n-1
    const memo = new Map();

    const best = (i, last, spent) => {
      if (i >= n) return { value: 0, take: false };

      const key = `${i},${last},${spent}`;
      const cached = memo.get(key);
      if (cached) return cached;

      const shift = candidates[i];
      const skip = best(i + 1, last, spent);
      let result = { value: skip.value, take: false };

      // Spend resets on crossing into a new week. Takes run in start order, so
      // the week of the last take is the week `spent` belongs to.
      const sameWeek = last >= 0 && weekStart(candidates[last].at) === weekStart(shift.at);
      const already = sameWeek ? spent : 0;
      const legal = last < 0 || fits(candidates[last], shift, minGapMinutes);

      if (legal && already + minutesOf(shift) <= roomIn(shift.at)) {
        const taken = best(i + 1, i, already + minutesOf(shift));
        const value = valueOf(shift, config) + taken.value;
        // Ties go to taking it. A shift in hand beats an equal one later.
        if (value >= result.value) result = { value, take: true };
      }

      memo.set(key, result);
      return result;
    };

    chosen = new Set();
    let last = -1;
    let spent = 0;
    for (let i = 0; i < n; i += 1) {
      if (!best(i, last, spent).take) continue;
      const sameWeek = last >= 0 && weekStart(candidates[last].at) === weekStart(candidates[i].at);
      spent = (sameWeek ? spent : 0) + minutesOf(candidates[i]);
      last = i;
      chosen.add(i);
    }
  }

  // By position, not by id. Selecting by id meant every row sharing an id came
  // back as taken, including rows the search never chose: three rows carrying
  // the same id turned one 8h pick into three claims and 24h under a 20h cap.
  // Rows with no id at all collided the same way.
  const takes = candidates.filter((_, index) => chosen.has(index));
  const missed = candidates.filter((_, index) => !chosen.has(index));

  // A screened-in shift that missed out deserves a reason that says which
  // constraint actually cost it, not a bare "not selected".
  const passedOver = (shift) => {
    const clash = takes.find((t) => t !== shift
      && !(fits(t, shift, minGapMinutes) || fits(shift, t, minGapMinutes)));
    if (clash) return `clashes with ${clash.station} on ${clash.start.slice(0, 10)}`;

    if (maxHoursPerWeek == null) return 'a better combination used the time';

    const spent = takes
      .filter((t) => weekStart(t.at) === weekStart(shift.at))
      .reduce((sum, t) => sum + (t.hours ?? 0), 0);
    const left = maxHoursPerWeek - hoursIn(mine, shift.at) - spent;
    return `needs ${shift.hours}h, ${left}h left of the ${maxHoursPerWeek}h week`;
  };

  return [
    ...takes.map((shift) => ({ shift, take: true, why: 'clear' })),
    ...missed.map((shift) => ({ shift, take: false, why: passedOver(shift) })),
    ...duplicates.map((shift) => ({ shift, take: false, why: `duplicate of shift ${shift.id} already on the board` })),
    ...rejected.map(({ shift, verdict }) => ({ shift, ...verdict })),
  ].sort((a, b) => a.shift.at - b.shift.at);
}

// Kept for the oversized-board fallback: first fit in date order.
function greedyPick(candidates, { mine, config, now }) {
  const held = [...mine];
  const chosen = new Set();

  candidates.forEach((shift, index) => {
    // skipOverlaps is forced on. The exact path forbids overlaps unconditionally
    // via fits(), and the fallback honoured the flag, so turning it off used to
    // make a big board claim six simultaneous shifts in one slot.
    if (!judge(shift, { mine: held, config: { ...config, skipOverlaps: true }, now }).take) return;
    held.push(shift);
    chosen.add(index);
  });

  return chosen;
}

export const judgeBoard = planBoard;

// Arming is deliberately in memory only. Restarting the server disarms, so a
// bot can never outlive the process that was told to run it.
export function createMadMax({ config, loadBoard, loadMine, claim, check, onEvent, afterSweep, intervalMs = 45000 }) {
  if (intervalMs < MIN_INTERVAL_MS) {
    console.warn(`madmax: ${intervalMs}ms sweep clamped to ${MIN_INTERVAL_MS}ms`);
    intervalMs = MIN_INTERVAL_MS;
  }

  let armed = false;
  let timer = null;
  let lastRun = null;
  let sweeping = false;
  const log = [];

  // What this process has claimed, remembered until the schedule read catches
  // up. loadMine is served from a 5 minute cache, so without this the sweep 30
  // seconds after a claim does not know about it: the cap looks 8h freer than it
  // is and the same week gets claimed twice. Server-side confirmation is the
  // real answer, this is the belt to that braces.
  const CLAIM_MEMORY_MS = 15 * MINUTE;
  let claimed = [];

  const rememberClaim = (shift) => {
    claimed = [...claimed.filter((c) => c.rememberedAt > Date.now() - CLAIM_MEMORY_MS), { shift, rememberedAt: Date.now() }];
  };

  // Union of what the server says I hold and what I know I just took.
  const everythingHeld = (mine) => {
    const known = new Set(mine.map((s) => s.id));
    return [
      ...mine,
      ...claimed.filter((c) => c.rememberedAt > Date.now() - CLAIM_MEMORY_MS && !known.has(c.shift.id)).map((c) => c.shift),
    ];
  };

  const record = (entry) => {
    const event = { at: new Date().toISOString(), ...entry };
    log.unshift(event);
    log.length = Math.min(log.length, 50);
    onEvent?.(event);
    return event;
  };

  async function sweep() {
    if (!armed) return;

    // setInterval does not wait for an async callback. A sweep can genuinely run
    // past 30s: the detail fetches are spaced 1.6s apart, so a board spanning
    // several weeks is seconds of sleep before the claims and the session
    // rotation even start. Two sweeps in flight would read the board inside the
    // 1.5s throttle and could fire two claims at the same shift.
    if (sweeping) {
      console.warn('madmax: previous sweep still running, skipping this tick');
      return;
    }

    sweeping = true;
    lastRun = new Date().toISOString();

    try {
      const [board, fresh] = await Promise.all([loadBoard(), loadMine()]);
      if (!board.length) return;

      const mine = everythingHeld(fresh);
      let held = [...mine];
      let pool = board;
      let plan = [];

      // A claim fails when somebody else got there first. Any shift the plan
      // passed over only because it clashed with that claim is takeable again,
      // so a lost race is re-planned against what actually landed instead of
      // walking away with the leftovers of a plan that no longer applies.
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        plan = planBoard(pool, { mine: held, config });

        // Every claim leaves at once, and before anything else in this tick:
        // awaiting them in turn made the second shift wait out the first round
        // trip, which against another bot is the whole margin. Most valuable
        // first, so if anything is going to be a photo finish it is the best
        // one. The plan is fixed before any of them fires, so the weekly cap is
        // still solved across candidates rather than raced.
        const takes = plan.filter((v) => v.take).map((v) => v.shift)
          .sort((a, b) => valueOf(b, config) - valueOf(a, config));

        if (!takes.length) break;

        const results = await Promise.all(takes.map(async (shift) => {
          const where = { shift: shift.id, station: shift.station, start: shift.start };
          try {
            // The claim was written from their client source and has never run.
            // checkOnly asks the server the same question through its read-only
            // endpoint, so the path can be proven against a real shift before
            // anything commits Amey to actual work.
            if (config.checkOnly) {
              const verdict = await check(shift);
              record({
                kind: 'checked', ...where,
                why: `server says canSwap=${verdict.canSwap}`
                  + `${verdict.approvalRequired ? ', approval required' : ''}`
                  + `${verdict.schId != null ? `, schId=${verdict.schId}` : ''}`
                  + `${verdict.checks?.length ? `, ${verdict.checks.length} checks` : ''}`,
              });
              return { shift, won: false };
            }

            await claim(shift);
            rememberClaim(shift);
            record({ kind: 'claimed', ...where, hours: shift.hours });
            return { shift, won: true };
          } catch (err) {
            record({ kind: 'failed', ...where, why: err.message });
            // A refusal here is usually just a lost race, but it can also be the
            // lockout, and this catch is inside Promise.all so it never reaches
            // the outer one. Left unchecked the sweep would carry on re-planning
            // and fire more writes into a board that has already cut us off.
            if (LOCKOUT.test(err.message)) throw err;
            return { shift, won: false };
          }
        }));

        // Nothing changed hands in a check-only sweep, so there is nothing to
        // re-plan against.
        if (config.checkOnly) break;

        const won = results.filter((r) => r.won).map((r) => r.shift);
        const lost = new Set(results.filter((r) => !r.won).map((r) => r.shift.id));

        held = [...held, ...won];
        // Won or lost, both leave the pool: one is mine now, the other is gone.
        pool = pool.filter((s) => !lost.has(s.id) && !won.some((w) => w.id === s.id));

        if (!lost.size) break;

        if (round === MAX_ROUNDS) {
          record({ kind: 'error', why: `stopped re-planning after ${MAX_ROUNDS} rounds` });
        }
      }

      // Only the surviving plan's rejections are worth a line. Earlier rounds
      // were superseded and logging them would bury the real reasons.
      for (const { shift, take, why } of plan) {
        if (!take) record({ kind: 'skipped', shift: shift.id, station: shift.station, start: shift.start, why });
      }
    } catch (err) {
      record({ kind: 'error', why: err.message });

      // Locked out. Every further request extends the lockout, so stand down
      // completely instead of retrying.
      if (LOCKOUT.test(err.message)) {
        record({ kind: 'disarmed', why: 'swap list locked out, standing down' });
        armed = false;
        clearInterval(timer);
        timer = null;
      }
    } finally {
      sweeping = false;

      // Upkeep belongs in the gap between sweeps, never in front of the next
      // one. Failing at it must not take the sweep down with it. Skipped once
      // disarmed, so a stand-down's last act is not a burst of sign-in traffic
      // at a board that has just cut us off.
      if (armed) {
        try {
          await afterSweep?.();
        } catch (err) {
          console.warn(`madmax: upkeep failed, ${err.message}`);
        }
      }
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
