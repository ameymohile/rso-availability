// The wiring, not the parts.
//
// budget.test.mjs proves the policy in isolation and madmax's own guards are
// tested by their rules. What banned the account on 2026-08-21 was neither: it
// was that the sweep and the refusal handling did not talk to each other. So
// these tests build the same graph server.mjs builds, with a fake board, and
// assert on what the bot does when the budget says no and when TeamWork does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBudget } from './budget.mjs';
import { createMadMax } from './madmax.mjs';

const LOCKOUT_400 = 'GET /api/shift/swapboard -> 400 "Swap list disabled. (30) minutes idle required for reset."';

// Real timers, but the numbers are tiny so the suite stays fast. The virtual
// clock is not usable here because madmax owns a setInterval of its own.
const until = async (predicate, why, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${why}`);
};

// Mirrors server.mjs: the cause travels with the read and decides which
// allowance it spends. Getting this mapping wrong is the whole bug, so the test
// reproduces the mapping rather than asserting on a stub.
function harness({ read, budget: budgetOpts = {} } = {}) {
  const events = [];
  const rests = [];

  const budget = createBudget({
    spacingMs: 10,
    routinePerMinute: 1,
    perMinute: 2,
    per10Minutes: 100,
    onRest: (r) => rests.push(r),
    ...budgetOpts,
  });

  const madmax = createMadMax({
    config: { maxHoursPerWeek: null, minNoticeMinutes: 0, minGapMinutes: 0 },
    intervalMs: 60_000,
    loadBoard: (cause) => budget.run(read, { kind: cause === 'poll' ? 'routine' : 'urgent' }),
    loadMine: async () => [],
    claim: async () => { throw new Error('this test never claims'); },
    check: async () => ({ canSwap: false }),
    onEvent: (event) => events.push(event),
  });

  const sawKind = (kind) => events.some((e) => e.kind === kind);
  const countKind = (kind) => events.filter((e) => e.kind === kind).length;

  return { budget, madmax, events, rests, sawKind, countKind };
}

test('a routine tick over its ceiling is held, not logged as an error', async () => {
  const reads = [];
  const h = harness({ read: async () => { reads.push('read'); return []; } });

  // arm() sweeps immediately with cause 'arm', which is urgent, and that spends
  // the one routine slot's worth of the per-minute allowance.
  h.madmax.arm();
  await until(() => reads.length === 1, 'the arming sweep');

  h.madmax.trigger('poll');
  await until(() => h.sawKind('held'), 'the routine tick to be held');

  const held = h.events.find((e) => e.kind === 'held');
  assert.match(held.why, /routine polls are capped/);
  assert.equal(h.countKind('error'), 0, 'a held tick must not read as an error');
  assert.equal(h.madmax.state.armed, true, 'and must not disarm the bot');
  assert.equal(reads.length, 1, 'and must not reach the server');

  h.madmax.disarm();
});

test('the reserve is real: a triggered read gets through when routine is spent', async () => {
  const reads = [];
  const h = harness({ read: async () => { reads.push('read'); return []; } });

  h.madmax.arm();
  await until(() => reads.length === 1, 'the arming sweep');

  h.madmax.trigger('poll');
  await until(() => h.sawKind('held'), 'the routine tick to be held');

  // This is the entire point of holding back allowance. Something outside the
  // timer says the board changed, and the read it needs is still available even
  // though routine polling has run out.
  h.madmax.trigger('mail: shift posted');
  await until(() => reads.length === 2, 'the triggered read to reach the server');

  h.madmax.disarm();
});

test('a lockout rests the budget, disarms, and stops reaching the server', async () => {
  let reads = 0;
  const h = harness({
    read: async () => { reads += 1; throw new Error(LOCKOUT_400); },
    budget: { routinePerMinute: 50, perMinute: 50 },
  });

  h.madmax.arm();
  await until(() => h.sawKind('disarmed'), 'the lockout to stand the bot down');

  assert.equal(reads, 1);
  assert.equal(h.madmax.state.armed, false);
  assert.equal(h.rests.length, 1);
  assert.equal(h.rests[0].ms, 31 * 60 * 1000);

  // The read that follows must not leave the machine. Every request during the
  // rest restarts TeamWork's 30 minute idle clock, which is how a 30 minute
  // lockout becomes an afternoon of them.
  await assert.rejects(
    () => h.budget.run(async () => { reads += 1; return []; }, { kind: 'urgent' }),
    (err) => err.budgetDenied,
  );
  assert.equal(reads, 1, 'nothing else was sent while resting');
});

test('a plain throttle 400 buys silence without disarming', async () => {
  let reads = 0;
  const h = harness({
    read: async () => {
      reads += 1;
      throw new Error('GET /api/shift/swapboard -> 400 "Please wait [1.5] seconds to refresh list."');
    },
    budget: { routinePerMinute: 50, perMinute: 50 },
  });

  h.madmax.arm();
  await until(() => h.sawKind('error'), 'the refusal to be recorded');

  // Still armed: being early is not being cut off. But the next read is refused
  // locally, which is the reaction that did not exist before and the reason a
  // run of these used to escalate into the real lockout.
  assert.equal(h.madmax.state.armed, true);
  assert.equal(h.budget.check('urgent').allowed, false);
  assert.match(h.budget.check('urgent').why, /backing off/);

  h.madmax.disarm();
});
