// Detection, moved off the endpoint that bans you.
//
// The board read is the expensive one: `api/shift/swapboard` refuses anything
// inside 1.5s, and a run of refusals ends in "Swap list disabled. (30) minutes
// idle required for reset." Polling it *is* how detection worked, so an empty
// board spent the entire allowance and the one moment that mattered arrived with
// nothing left to spend. That is the trade this file removes.
//
// `api/shift/swapboardCounts` answers the same question more cheaply and more
// widely: one request returns ~84 days of per-day `SwapCount`, which is three
// months where a board read covers one. Measured on 2026-08-21 with
// probe.mjs --floor: four calls at every spacing from 3000ms down to 200ms, all
// 200, no refusal at any step. The board endpoint refuses at 1000ms.
//
// So counts carries the frequency and the board endpoint is touched only when a
// count actually moves. When it does, the changed day tells us which month to
// read, so the board read is one aimed request instead of a guess.
//
// Sustained rate is *not* proven. The floor probe sends four calls per step, so
// a burst ceiling wider than that would not have shown up, and the 125 refusals
// at 03:23 on 2026-08-21 tell us nothing about rate because they were a bad
// `date` parameter. Hence its own budget, its own backoff, and a default
// interval far above the fastest spacing that answered.

const DAY_MS = 86400000;

export function createDetector({
  loadCounts,
  onPosting,
  onEvent,
  budget,
  intervalMs = 1500,
  // Days further out than this are still reported, but they are not a race: a
  // posting eleven weeks away will still be there after the next poll.
  urgentWithinDays = 21,
} = {}) {
  let timer = null;
  let polling = false;
  // Bumped by stop(). A poll already in flight when the watcher stops finishes
  // afterwards and used to seed the baseline it had just been told to drop, so
  // the next arm compared against a board from before the pause. Seen in the
  // wild: two "detector-baseline" lines for one stop.
  let epoch = 0;
  // null until the first successful poll. Without it the first poll would read
  // every day with a shift on it as a brand new posting and fire a board read
  // for a board that has looked like that all morning.
  let baseline = null;
  let status = {
    state: 'off', since: null, polls: 0, refusals: 0, lastPollAt: null, lastMs: null,
    lastChangeAt: null, days: 0, error: null,
  };

  const set = (patch) => {
    status = { ...status, ...patch };
    onEvent?.({ kind: 'detector-status', ...status });
  };

  const monthAnchor = (date) => `${date.slice(0, 7)}-01`;

  // Only upward moves. A count falling means somebody claimed it, which is news
  // but not an opportunity, and treating it as one would fire a board read every
  // time a competitor won.
  function changesFrom(before, after) {
    const changed = [];

    for (const [date, row] of after) {
      const was = before.get(date);
      const grew = row.swaps > (was?.swaps ?? 0);
      // Offered directly to me. Worth a look even with no count change, because
      // the day-level count can already have been non-zero.
      const newlyOffered = row.toMe && !was?.toMe;

      if (grew || newlyOffered) {
        changed.push({
          date, from: was?.swaps ?? 0, to: row.swaps, offered: row.toMe,
        });
      }
    }

    return changed;
  }

  async function poll() {
    // Two polls in flight would compare each other's baselines and lose a
    // change. The interval is short enough that a slow reply makes this real.
    if (polling) return;
    polling = true;

    const at = Date.now();
    const mine = epoch;
    try {
      const rows = await budget.run(() => loadCounts(), { kind: 'routine' });
      // Stopped while this was in flight. Its answer describes a board nobody is
      // watching any more, and recording it would defeat the rebaseline.
      if (mine !== epoch) return;

      const after = new Map(rows.map((row) => [row.date, row]));

      status.polls += 1;
      set({
        lastPollAt: new Date(at).toISOString(), lastMs: Date.now() - at, days: after.size, error: null,
      });

      if (!baseline) {
        baseline = after;
        onEvent?.({ kind: 'detector-baseline', why: `${after.size} days on the board` });
        return;
      }

      const changed = changesFrom(baseline, after);
      baseline = after;
      if (!changed.length) return;

      const soon = changed.filter((c) => new Date(c.date).getTime() - at < urgentWithinDays * DAY_MS);
      const anchors = [...new Set(changed.map((c) => monthAnchor(c.date)))];
      const summary = changed
        .map((c) => `${c.date} ${c.from}->${c.to}${c.offered ? ' (offered to me)' : ''}`)
        .join(', ');

      set({ lastChangeAt: new Date().toISOString() });
      onEvent?.({ kind: 'posting', why: summary });
      onPosting?.({ changed, anchors, urgent: soon.length > 0, why: summary });
    } catch (err) {
      // A budget denial is the system working and says nothing about the board,
      // so it must not be recorded as a detector fault or reset the baseline.
      if (mine !== epoch) return;
      if (!err.budgetDenied) {
        status.refusals += 1;
        set({ error: err.message });
        onEvent?.({ kind: 'detector-error', why: err.message });
      }
    } finally {
      polling = false;
    }
  }

  return {
    get status() {
      return { ...status, intervalMs, configured: typeof loadCounts === 'function' };
    },

    // Exposed so a test can drive a poll without waiting on a timer.
    poll,

    start() {
      if (timer) return;
      set({ state: 'watching', since: new Date().toISOString() });
      timer = setInterval(poll, intervalMs);
      poll();
    },

    stop() {
      clearInterval(timer);
      timer = null;
      epoch += 1;
      // The baseline is dropped on purpose. After a pause of unknown length it
      // describes a board that no longer exists, and comparing against it would
      // report every shift posted during the gap as new.
      baseline = null;
      set({ state: 'off', since: null });
    },
  };
}
