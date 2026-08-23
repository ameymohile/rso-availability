// What the detector must never do: fire on the board it found when it started,
// fire when a competitor takes a shift, or lose a change because a poll was
// refused. Each of those is a wrong board read, and a wrong board read spends
// allowance that the real posting needs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from './detect.mjs';

const day = (date, swaps, toMe = false) => ({ date, swaps, toMe });

// Serves a scripted sequence of boards, one per poll.
function harness(boards, { budget } = {}) {
  const postings = [];
  const events = [];
  let index = 0;

  const detector = createDetector({
    budget: budget ?? { run: (fn) => fn() },
    loadCounts: async () => boards[Math.min(index++, boards.length - 1)],
    onPosting: (posting) => postings.push(posting),
    onEvent: (event) => events.push(event),
  });

  return { detector, postings, events };
}

test('the first poll is a baseline and fires nothing', async () => {
  // A board with three shifts already on it when the bot arms is not three new
  // postings. Firing here would burn the board allowance on old news, every arm.
  const h = harness([[day('2026-08-22', 3)]]);

  await h.detector.poll();

  assert.equal(h.postings.length, 0);
  assert.ok(h.events.some((e) => e.kind === 'detector-baseline'));
});

test('a count going up fires once, naming the month to read', async () => {
  const h = harness([
    [day('2026-09-14', 0)],
    [day('2026-09-14', 1)],
  ]);

  await h.detector.poll();
  await h.detector.poll();

  assert.equal(h.postings.length, 1);
  assert.deepEqual(h.postings[0].anchors, ['2026-09-01']);
  assert.equal(h.postings[0].changed[0].from, 0);
  assert.equal(h.postings[0].changed[0].to, 1);
});

test('a count going down fires nothing', async () => {
  // Somebody else claimed it. That is news, but it is not an opportunity, and
  // reading the board over it means paying for every race we already lost.
  const h = harness([
    [day('2026-08-25', 2)],
    [day('2026-08-25', 1)],
    [day('2026-08-25', 0)],
  ]);

  await h.detector.poll();
  await h.detector.poll();
  await h.detector.poll();

  assert.equal(h.postings.length, 0);
});

test('newly offered to me fires even with the count unchanged', async () => {
  // The day-level count can already be non-zero when a shift is offered to me
  // directly, so SwapToYou has to be watched on its own.
  const h = harness([
    [day('2026-08-23', 1, false)],
    [day('2026-08-23', 1, true)],
  ]);

  await h.detector.poll();
  await h.detector.poll();

  assert.equal(h.postings.length, 1);
  assert.equal(h.postings[0].changed[0].offered, true);
});

test('a change more than three weeks out is reported but not urgent', async () => {
  const far = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const h = harness([[day(far, 0)], [day(far, 1)]]);

  await h.detector.poll();
  await h.detector.poll();

  assert.equal(h.postings.length, 1);
  assert.equal(h.postings[0].urgent, false, 'a posting two months out is not a race');
});

test('a refused poll keeps the baseline and is not a detector fault', async () => {
  const denied = Object.assign(new Error('budget: 45/min ceiling reached (12s)'), { budgetDenied: true });
  let allow = true;

  const h = harness([
    [day('2026-08-24', 0)],
    [day('2026-08-24', 1)],
  ], {
    budget: { run: (fn) => (allow ? fn() : Promise.reject(denied)) },
  });

  await h.detector.poll();      // baseline at 0
  allow = false;
  await h.detector.poll();      // refused, must change nothing
  allow = true;
  await h.detector.poll();      // sees 1, and 1 > 0 still holds

  assert.equal(h.postings.length, 1, 'the change survived a refused poll in between');
  assert.equal(h.detector.status.refusals, 0, 'a budget denial is not a detector error');
  assert.ok(!h.events.some((e) => e.kind === 'detector-error'));
});

test('a real error is recorded and does not move the baseline', async () => {
  let fail = false;
  const detector = createDetector({
    budget: { run: (fn) => fn() },
    loadCounts: async () => {
      if (fail) throw new Error('GET /api/shift/swapboardCounts -> 400 (empty body)');
      return [day('2026-08-26', 0)];
    },
    onPosting: () => { throw new Error('must not fire'); },
  });

  await detector.poll();
  fail = true;
  await detector.poll();

  assert.equal(detector.status.refusals, 1);
  assert.match(detector.status.error, /empty body/);
});

test('a poll still in flight when stopped does not seed the baseline', async () => {
  // Seen live: disarming logged a second "detector-baseline" because the poll in
  // flight finished afterwards and rebuilt the state stop() had just dropped.
  // The next arm then compared against a board from before the pause.
  let release;
  const postings = [];
  const events = [];

  const detector = createDetector({
    budget: { run: (fn) => fn() },
    loadCounts: () => new Promise((resolve) => { release = () => resolve([day('2026-08-28', 5)]); }),
    onPosting: (p) => postings.push(p),
    onEvent: (e) => events.push(e),
  });

  const inFlight = detector.poll();
  detector.stop();
  release();
  await inFlight;

  assert.equal(
    events.filter((e) => e.kind === 'detector-baseline').length, 0,
    'the abandoned poll must not report a baseline',
  );
  assert.equal(postings.length, 0);
});

test('stopping drops the baseline so a resumed watch is not a flood', async () => {
  const h = harness([
    [day('2026-08-27', 4)],
    [day('2026-08-27', 4)],
  ]);

  await h.detector.poll();
  h.detector.stop();
  await h.detector.poll();

  // The board looks the same, but after a pause of unknown length the old
  // baseline describes a board that no longer exists. Rebaselining is the only
  // honest option, and it must not be mistaken for four new postings.
  assert.equal(h.postings.length, 0);
  assert.equal(h.events.filter((e) => e.kind === 'detector-baseline').length, 2);
});
