// The budget's whole job is to make a lockout structurally impossible, so these
// tests are about what it refuses, not what it allows. Virtual clock, so every
// number below is the number the budget computed rather than timer slop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBudget } from './budget.mjs';

const THROTTLE_400 = 'GET /api/shift/swapboard?date=2026-08-21&range=month -> 400 "Please wait [1.5] seconds to refresh list."';
const LOCKOUT_400 = 'GET /api/shift/swapboard?date=2026-08-21&range=month -> 400 "Swap list disabled. (30) minutes idle required for reset."';

function fakeClock() {
  let at = 1_000_000;
  return {
    now: () => at,
    sleep: (ms) => { at += ms; return Promise.resolve(); },
    advance: (ms) => { at += ms; },
  };
}

const build = (clock, opts = {}) => createBudget({
  now: clock.now, sleep: clock.sleep, ...opts,
});

test('spacing is enforced across callers, and is a wait not a refusal', async () => {
  const clock = fakeClock();
  const budget = build(clock, { spacingMs: 2000 });
  const sent = [];

  await Promise.all([1, 2, 3].map(() => budget.run(async () => { sent.push(clock.now()); })));

  assert.equal(sent.length, 3);
  assert.equal(sent[1] - sent[0], 2000);
  assert.equal(sent[2] - sent[1], 2000);
});

test('routine polls stop at their ceiling and leave headroom for a triggered read', async () => {
  const clock = fakeClock();
  const budget = build(clock, { spacingMs: 1000, routinePerMinute: 3, perMinute: 5 });

  for (let i = 0; i < 3; i += 1) {
    await budget.run(async () => 'ok', { kind: 'routine' });
  }

  // The fourth routine poll is refused even though a minute has not passed and
  // the spacing is fine. This is the case that matters: a sweep must not be able
  // to spend the whole allowance on empty boards.
  await assert.rejects(
    () => budget.run(async () => 'ok', { kind: 'routine' }),
    (err) => err.budgetDenied && /held for triggered reads/.test(err.message),
  );

  // The read that a posting triggered still gets through, which is the entire
  // point of reserving the difference.
  assert.equal(await budget.run(async () => 'claimed', { kind: 'urgent' }), 'claimed');
});

test('one throttle 400 buys silence instead of another request', async () => {
  const clock = fakeClock();
  const budget = build(clock, { spacingMs: 1000 });

  await assert.rejects(() => budget.run(async () => { throw new Error(THROTTLE_400); }));

  // The old behaviour was to log this and carry on at the same cadence. Now the
  // next request is refused outright until the backoff expires.
  const verdict = budget.check('urgent');
  assert.equal(verdict.allowed, false);
  assert.match(verdict.why, /refusal/);
  assert.equal(verdict.waitMs, 10_000);

  clock.advance(10_000);
  assert.equal(budget.check('urgent').allowed, true);
});

test('consecutive refusals back off exponentially and a success clears it', async () => {
  const clock = fakeClock();
  const budget = build(clock, { spacingMs: 1000 });
  const waits = [];

  for (const expected of [10_000, 30_000, 120_000, 600_000, 600_000]) {
    await assert.rejects(() => budget.run(async () => { throw new Error(THROTTLE_400); }));
    waits.push(budget.check('urgent').waitMs);
    assert.equal(waits.at(-1), expected);
    clock.advance(expected);
  }

  await budget.run(async () => 'ok');
  assert.equal(budget.state.refusals, 0);

  await assert.rejects(() => budget.run(async () => { throw new Error(THROTTLE_400); }));
  assert.equal(budget.check('urgent').waitMs, 10_000, 'backoff restarts from the first step after a success');
});

test('the lockout rests 31 minutes and nothing shortens it', async () => {
  const clock = fakeClock();
  const rests = [];
  const budget = build(clock, { spacingMs: 1000, onRest: (r) => rests.push(r) });

  await assert.rejects(() => budget.run(async () => { throw new Error(LOCKOUT_400); }));

  assert.equal(budget.state.restingUntil, clock.now() + 31 * 60_000);
  assert.equal(rests.at(-1).ms, 31 * 60_000);

  // A soft throttle arriving during the hard rest must not talk the breaker into
  // asking again in ten seconds.
  clock.advance(60_000);
  budget.report(THROTTLE_400);
  assert.ok(budget.check('urgent').waitMs > 29 * 60_000);
});

test('a network error or a 500 does not buy backoff', async () => {
  const clock = fakeClock();
  const budget = build(clock, { spacingMs: 1000 });

  await assert.rejects(() => budget.run(async () => { throw new Error('fetch failed'); }));
  await assert.rejects(() => budget.run(async () => { throw new Error('GET /api/shift/swapboard -> 500'); }));

  // Only the spacing stands between us and the next attempt. Treating a flaky
  // connection as evidence about our request rate would rest the bot for ten
  // minutes over something that was never our fault.
  assert.equal(budget.state.refusals, 0);
  assert.equal(budget.check('urgent').allowed, true);
});

test('a 400 with no message is still a refusal', async () => {
  const clock = fakeClock();
  const budget = build(clock, { spacingMs: 1000 });

  // swapboardCounts answers 400 with an empty body. 125 of these in a row on
  // 2026-08-21 changed nothing about the request rate, because the old handling
  // only recognised refusals that explained themselves.
  await assert.rejects(() => budget.run(async () => {
    throw new Error('GET /api/shift/swapboardCounts?date=2026-08-20&fillgaps=true -> 400 (empty body)');
  }));

  assert.equal(budget.state.refusals, 1);
  assert.equal(budget.check('urgent').allowed, false);
  assert.equal(budget.check('urgent').waitMs, 10_000);
});

test('a stale session is repaired, not rested', async () => {
  const clock = fakeClock();
  const budget = build(clock, { spacingMs: 1000 });

  await assert.rejects(() => budget.run(async () => {
    throw new Error('GET /api/shift/swapboard -> 401 Invalid Token');
  }));

  // Resting ten minutes over a token that needs one sign-in to replace would
  // turn a one-second repair into an outage.
  assert.equal(budget.state.refusals, 0);
  assert.equal(budget.check('urgent').allowed, true);
});

test('a rest recorded before this process started is still in force', () => {
  const clock = fakeClock();
  const until = clock.now() + 5 * 60_000;
  const budget = build(clock, { restoreRestUntil: until });

  const verdict = budget.check('urgent');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.waitMs, 5 * 60_000);
  assert.match(verdict.why, /before this process started/);
});

test('a ten minute ceiling holds even when every gap is legal', async () => {
  const clock = fakeClock();
  const budget = build(clock, {
    spacingMs: 2000, routinePerMinute: 100, perMinute: 100, per10Minutes: 20,
  });

  for (let i = 0; i < 20; i += 1) {
    await budget.run(async () => 'ok', { kind: 'urgent' });
  }

  await assert.rejects(
    () => budget.run(async () => 'ok', { kind: 'urgent' }),
    (err) => /10min ceiling/.test(err.message),
  );
  assert.equal(budget.state.last10Minutes, 20);
});

test('requests are counted when they are sent, not when they succeed', async () => {
  const clock = fakeClock();
  const budget = build(clock, { spacingMs: 1000 });

  await assert.rejects(() => budget.run(async () => { throw new Error('GET -> 500'); }));

  // The server counts arrivals. Crediting only the successes would let a run of
  // refusals look like an idle client and spend the allowance twice.
  assert.equal(budget.state.lastMinute, 1);
});
