// The spacing invariant, on a virtual clock.
//
// Only one thing is being asserted here and it is the one the server punishes us
// for getting wrong: no two swapboard requests leave less than the gate's
// spacing apart, no matter how many callers there are or how many requests one
// read makes. Real timers would make this a slow flaky test about setTimeout
// slop, so the gate's injectable now/sleep drive a fake clock instead and the
// assertions are exact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from './gate.mjs';
import { loadOpenShifts } from './tmwork.mjs';

const SPACING = 1600;
// Latency has to be in the model. The old arrangement only broke because a
// request took real time to come back, so a zero-cost fake request would have
// looked correct.
const RTT = 150;

// Advances on sleep, so the whole test runs in no wall clock time and the
// numbers in the assertions are the numbers the gate computed.
function fakeClock() {
  let at = 0;
  return {
    now: () => at,
    sleep: (ms) => {
      at += ms;
      return Promise.resolve();
    },
    advance: (ms) => { at += ms; },
  };
}

// Records when each request left rather than what it returned. One future shift
// so the return value is not vacuously empty.
function fakeSession(clock, sent) {
  return {
    async getJson(path) {
      sent.push({ at: clock.now(), path });
      clock.advance(RTT);
      return [{
        Id: 1, Start: '2099-01-01T08:00:00', End: '2099-01-01T16:00:00',
        Hours: 8, StnName: 'West Village H', LocId: 42, CheckSum: 'cs', CanSwap: true,
      }];
    },
  };
}

const gaps = (sent) => sent.slice(1).map((s, i) => s.at - sent[i].at);

test('every request from one read is spaced, not just the first', async () => {
  const clock = fakeClock();
  const gate = createGate({ spacingMs: SPACING, sleep: clock.sleep, now: clock.now });
  const sent = [];
  const session = fakeSession(clock, sent);

  // Three reads back to back. loadOpenShifts reads a second anchor on some
  // sweeps, so this covers both the one-request and two-request shapes without
  // depending on which sweep number this happens to be.
  for (let i = 0; i < 3; i += 1) {
    await loadOpenShifts(session, { via: (fn) => gate.run(fn) });
  }

  assert.ok(sent.length >= 3, `expected at least 3 requests, got ${sent.length}`);
  for (const gap of gaps(sent)) {
    assert.ok(gap >= SPACING, `two requests left ${gap}ms apart, floor is ${SPACING}ms`);
  }
});

test('two callers reading at once still respect the floor between them', async () => {
  const clock = fakeClock();
  const gate = createGate({ spacingMs: SPACING, sleep: clock.sleep, now: clock.now });
  const sent = [];
  const session = fakeSession(clock, sent);

  // The case that made this necessary: the UI poll and an armed sweep, or a mail
  // trigger arriving mid-sweep. Nothing coordinates them except the gate.
  await Promise.all([
    loadOpenShifts(session, { via: (fn) => gate.run(fn) }),
    loadOpenShifts(session, { via: (fn) => gate.run(fn) }),
  ]);

  for (const gap of gaps(sent)) {
    assert.ok(gap >= SPACING, `two requests left ${gap}ms apart, floor is ${SPACING}ms`);
  }
});

test('the arrangement this replaced does violate the floor', async () => {
  const clock = fakeClock();
  const gate = createGate({ spacingMs: SPACING, sleep: clock.sleep, now: clock.now });
  const sent = [];
  const session = fakeSession(clock, sent);

  // What server.mjs used to do: one gate slot for the whole read, and the read
  // spacing its own requests with a sleep. The gate stamps its clock before the
  // read starts, so a two-request read ends about a spacing later and the next
  // read is cleared to go immediately. This is the 400 in madmax-log at 15:47 on
  // 2026-08-21, reproduced, so that nobody re-wraps it this way.
  const oldStyleRead = async () => {
    for (const [index] of [0, 1].entries()) {
      if (index) await clock.sleep(SPACING);
      await session.getJson('/api/shift/swapboard?range=month');
    }
  };

  await gate.run(oldStyleRead);
  await gate.run(oldStyleRead);

  const worst = Math.min(...gaps(sent));
  assert.ok(worst < SPACING, `expected the old arrangement to breach the floor, worst gap was ${worst}ms`);
});

test('without a gate the read still works, one request at a time', async () => {
  const clock = fakeClock();
  const sent = [];
  const open = await loadOpenShifts(fakeSession(clock, sent));

  assert.ok(sent.length >= 1);
  assert.equal(open.length, 1);
  assert.equal(open[0].locId, 42);
  assert.equal(open[0].checkSum, 'cs');
  assert.equal(open[0].mode, 'claim');
});
