// One owner of the question "may I ask the board right now".
//
// The lockout on 2026-08-21 was not caused by a single request being 100ms early.
// It was caused by nothing in the system reacting to a refusal. `gate.mjs` spaces
// requests, and `server.mjs` stands down for 31 minutes when TeamWork says
// "Swap list disabled", but a plain 400 "Please wait [1.5] seconds to refresh
// list." did nothing at all: it was logged as an error and the next tick went out
// on schedule at the same cadence that had just been refused. Refusals are what
// escalate, every one of them restarts the 30 minute idle clock, and we were
// producing them steadily and calling it an error log.
//
// So this file is deliberately pessimistic. Three layers, and a request has to
// pass all three:
//
//   1. Spacing. A hard floor per request, above the 1500ms the server declares.
//   2. Rolling caps. A ceiling per minute and per ten minutes, so no burst is
//      possible even when every individual gap is legal. This is what a mail
//      trigger arriving during a sweep used to defeat.
//   3. Backoff. Any refusal, not only the lockout, buys silence, and consecutive
//      refusals buy exponentially more of it.
//
// It also reserves headroom. The read that matters is the one right after a
// shift is posted, and it is worthless if a routine poll has just spent the last
// slot. Routine polls may only spend down to `routinePerMinute`; the rest of the
// per-minute allowance is kept for reads that something actually triggered.
//
// Nothing here is a guess about the server's real thresholds, because those are
// not knowable from the client. It is a budget small enough that the thresholds
// stop mattering.

// Spacing and serialisation stay in gate.mjs. This file is policy: how many, how
// often, and what to do when the answer comes back as a refusal. Reimplementing
// the queue here would leave two things stamping two clocks for the same
// requests, which is how the spacing bug happened the first time.
import { createGate } from './gate.mjs';

// "Please wait [1.5] seconds to refresh list." The soft one: we were early.
const THROTTLED = /please wait|seconds to refresh/i;

// "Swap list disabled. (30) minutes idle required for reset." The hard one.
const LOCKED_OUT = /disabled|idle required|locked out/i;

// A refusal that says nothing. swapboardCounts answers 400 with an empty body,
// which is why 125 of them in a row at 03:23 on 2026-08-21 looked like a bug in
// our code rather than the server turning us away. Anything in the 4xx range is
// the server declining, and declining to guess why is not a reason to keep
// asking at the same rate.
const REFUSED = /->\s*4\d\d\b/;

// Except these two. A stale session is not a rate problem: the fix is to sign in
// again, and resting ten minutes over it would turn a one-second repair into an
// outage.
const AUTH = /->\s*40[13]\b|invalid token/i;

// Each consecutive refusal buys the next one of these. The first step is longer
// than any sweep interval on purpose: the correct response to being told we are
// early is to be conspicuously late, not to try again 1.6s later.
const BACKOFF_MS = [10_000, 30_000, 120_000, 600_000];

// TeamWork wants 30 minutes with nothing asking. The extra minute is for clock
// skew between us and them, since being 20 seconds early costs another 30.
const LOCKOUT_REST_MS = 31 * 60 * 1000;

export function createBudget({
  spacingMs = 2000,
  perMinute = 12,
  routinePerMinute = 8,
  per10Minutes = 60,
  restoreRestUntil = 0,
  onRest,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const gate = createGate({ spacingMs, sleep, now });

  // Send timestamps, newest last. Only ever as long as the ten minute window.
  let sends = [];
  let refusals = 0;
  let restUntil = restoreRestUntil;
  let restReason = restoreRestUntil > now() ? 'a lockout recorded before this process started' : null;

  const prune = () => {
    const cutoff = now() - 10 * 60_000;
    if (sends.length && sends[0] < cutoff) sends = sends.filter((at) => at >= cutoff);
  };

  const countSince = (ms) => {
    const cutoff = now() - ms;
    let n = 0;
    for (let i = sends.length - 1; i >= 0 && sends[i] >= cutoff; i -= 1) n += 1;
    return n;
  };

  const rest = (ms, why) => {
    const until = now() + ms;
    // Never shorten a rest already in progress. A soft backoff arriving during a
    // hard lockout must not talk us into asking sooner.
    if (until <= restUntil) return;
    restUntil = until;
    restReason = why;
    onRest?.({ until, why, ms });
  };

  // Pure: says whether a request may go out and why not. Spends nothing, so the
  // UI and the logs can ask without consequence.
  function check(kind = 'routine') {
    prune();
    const at = now();

    if (at < restUntil) {
      return { allowed: false, waitMs: restUntil - at, why: `resting: ${restReason}` };
    }

    // Caps before spacing, because a cap is a refusal and spacing is only a
    // wait. Checking spacing first would return "allowed, in 400ms" and skip the
    // ceilings entirely for any caller that happened to be early.
    const lastMinute = countSince(60_000);
    const ceiling = kind === 'routine' ? routinePerMinute : perMinute;
    if (lastMinute >= ceiling) {
      return {
        allowed: false,
        waitMs: 60_000 - (at - sends[sends.length - lastMinute]),
        why: kind === 'routine'
          ? `routine polls are capped at ${routinePerMinute}/min, the rest is held for triggered reads`
          : `${perMinute}/min ceiling reached`,
      };
    }

    if (countSince(10 * 60_000) >= per10Minutes) {
      return { allowed: false, waitMs: 60_000, why: `${per10Minutes}/10min ceiling reached` };
    }

    // Spacing is the gate's business, so "allowed" here means allowed by policy.
    // The caller may still wait out the remainder of a gap on the way through.
    return { allowed: true, waitMs: 0, why: null };
  }

  // A request went out. Recorded before the reply, because the server counts
  // arrivals and so must we: crediting only successes would let a run of
  // refusals look like an idle client.
  function record() {
    sends.push(now());
    prune();
  }

  // The reply came back. This is the feedback loop that was missing.
  function report(errorMessage) {
    if (!errorMessage) {
      refusals = 0;
      return { kind: 'ok' };
    }

    if (LOCKED_OUT.test(errorMessage)) {
      refusals += 1;
      rest(LOCKOUT_REST_MS, 'swap list disabled, 30 minutes of silence required');
      return { kind: 'locked-out', restMs: LOCKOUT_REST_MS };
    }

    if (AUTH.test(errorMessage)) return { kind: 'auth' };

    if (THROTTLED.test(errorMessage) || REFUSED.test(errorMessage)) {
      refusals += 1;
      const ms = BACKOFF_MS[Math.min(refusals - 1, BACKOFF_MS.length - 1)];
      rest(ms, `${refusals} refusal${refusals > 1 ? 's' : ''} in a row, backing off`);
      return { kind: THROTTLED.test(errorMessage) ? 'throttled' : 'refused', restMs: ms };
    }

    // A network error or a 500 is not evidence about our rate, so it must not
    // buy backoff. Counting it would let a flaky connection talk the bot into a
    // ten minute rest it did not earn.
    return { kind: 'other' };
  }

  return {
    check,
    record,
    report,

    // Imposed from outside, for the case where a sibling budget learns something
    // this one has no way to see. A lockout arrives through whichever endpoint
    // happened to ask, and it applies to all of them, so the one that hears it
    // has to be able to silence the others.
    rest,

    // Only the hard question: are we meant to be silent right now. A claim asks
    // this and nothing else, because a claim must never be held back by a
    // ceiling that exists to protect the *read* endpoint.
    get resting() {
      const at = now();
      return at < restUntil ? { until: restUntil, why: restReason, waitMs: restUntil - at } : null;
    },

    get state() {
      prune();
      return {
        spacingMs,
        perMinute,
        routinePerMinute,
        lastMinute: countSince(60_000),
        last10Minutes: countSince(10 * 60_000),
        refusals,
        restingUntil: restUntil > now() ? restUntil : 0,
        restReason: restUntil > now() ? restReason : null,
      };
    },

    // Serialised and spaced by the gate, capped and backed off by the policy
    // above, and it reports the outcome back to itself so the next caller
    // inherits what this one learned. Rejects rather than queues when a cap is
    // hit: holding callers behind a ceiling only guarantees a burst the moment it
    // clears, and a poll that is 40s late is worth nothing anyway.
    run(fn, { kind = 'routine' } = {}) {
      const denied = (verdict) => {
        const err = new Error(`budget: ${verdict.why} (${Math.ceil(verdict.waitMs / 1000)}s)`);
        err.budgetDenied = true;
        err.retryInMs = verdict.waitMs;
        return err;
      };

      const verdict = check(kind);
      if (!verdict.allowed) return Promise.reject(denied(verdict));

      return gate.run(async () => {
        // Re-checked on the way out of the queue. The verdict above was taken
        // before anything already queued had sent, and a refusal landing in the
        // meantime has to be able to stop this request too.
        const inner = check(kind);
        if (!inner.allowed) throw denied(inner);

        record();
        try {
          const value = await fn();
          report(null);
          return value;
        } catch (err) {
          if (!err.budgetDenied) report(err.message);
          throw err;
        }
      });
    },
  };
}
