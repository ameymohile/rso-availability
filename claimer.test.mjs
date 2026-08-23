// The two things that would actually hurt: claiming the wrong shift, and
// claiming a shift that breaks his own rules. Everything here is one of those.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaimer, judge, matchShift } from './claimer.mjs';

const ALERT = {
  from: 'mailer@schedulesource.com',
  subject: 'TeamWork ALERT: SHIFT AVAILABLE',
  body: `SHIFT AVAILABLE:

[RSO Boston][Hamper Station Duty]
Thursday, 08/13/2026  12:45pm - 5:15pm

BY: Mehta, Aryan`,
};

// The shift the alert describes, as the board would return it.
const ROW = {
  id: 53005358,
  start: '2026-08-13T12:45:00',
  end: '2026-08-13T17:15:00',
  hours: 4.5,
  station: 'Hamper Station Duty',
  locId: 3557,
  mode: 'claim',
};

// 08/13/2026 09:00 local, well before the shift and after the mail.
const NOW = new Date(2026, 7, 13, 9, 0, 0).getTime();

// Same harness, but with the clock moved, for the rules that are about "how far
// away is this shift right now".
function createClaimerAt(when, options = {}) {
  return harness({ ...options, now: when });
}

function harness({ board = [ROW], mine = [], config = {}, claimResult, now = NOW } = {}) {
  const claims = [];
  const checks = [];
  const events = [];
  const boardReads = [];

  const claimer = createClaimer({
    config: { minNoticeMinutes: 60, ...config },
    now: () => now,
    loadBoard: async (date) => { boardReads.push(date); return board; },
    loadMine: async () => mine,
    claim: async (row) => {
      claims.push(row);
      if (claimResult instanceof Error) throw claimResult;
      return claimResult ?? { id: row.id, ms: 92, warm: true };
    },
    check: async (row) => { checks.push(row); return { canSwap: true, approvalRequired: false }; },
    onEvent: (e) => events.push(e),
  });

  return { claimer, claims, checks, events, boardReads };
}

const kinds = (events) => events.map((e) => e.kind);

test('an alert becomes exactly one board read and one claim', async () => {
  const h = harness();
  const result = await h.claimer.onMail(ALERT);

  assert.equal(result.claimed, true);
  assert.deepEqual(h.boardReads, ['2026-08-13'], 'one read, aimed at the date in the mail');
  assert.equal(h.claims.length, 1);
  assert.equal(h.claims[0].id, ROW.id);
  assert.deepEqual(kinds(h.events), ['alert', 'claimed']);
  assert.match(h.events.at(-1).why, /ms from the alert/);
});

test('a mail that is not a shift alert costs no requests', async () => {
  const h = harness();
  await h.claimer.onMail({ ...ALERT, subject: 'TeamWork ALERT: SCHEDULE PUBLISHED' });

  assert.deepEqual(h.boardReads, [], 'the board must not be touched');
  assert.equal(h.claims.length, 0);
  assert.deepEqual(kinds(h.events), ['ignored']);
});

test('a shift already taken by someone else is a lost race, not an error', async () => {
  // The usual outcome when another bot is faster: the mail arrives, the board
  // read comes back without it.
  const h = harness({ board: [] });
  const result = await h.claimer.onMail(ALERT);

  assert.equal(result.claimed, false);
  assert.deepEqual(kinds(h.events), ['alert', 'gone']);
  assert.match(h.events.at(-1).why, /nothing on the board/);
  assert.equal(h.claims.length, 0);
});

test('a board row at the right time but the wrong station is still claimed', async () => {
  // The email writes the station one way and the board may write it another, so
  // a single row at exactly the right start and end is the shift in the email.
  // Refusing it over a naming difference would lose a shift we were told about.
  const renamed = { ...ROW, station: 'Hamper Duty' };
  const h = harness({ board: [renamed] });

  const result = await h.claimer.onMail(ALERT);

  assert.equal(result.claimed, true);
  assert.match(h.events.at(-1).why, /station reads "Hamper Duty"/);
});

test('two rows at the same time and neither matching the station is refused', async () => {
  // A claim commits Amey to real work, so an ambiguous board is a refusal rather
  // than a coin toss.
  const h = harness({
    board: [
      { ...ROW, id: 1, station: 'Kerr Hall' },
      { ...ROW, id: 2, station: 'West Village A' },
    ],
  });

  const result = await h.claimer.onMail(ALERT);

  assert.equal(result.claimed, false);
  assert.equal(h.claims.length, 0);
  assert.match(h.events.at(-1).why, /too ambiguous/);
});

test('two identical rows take the first rather than refusing', async () => {
  const h = harness({ board: [{ ...ROW, id: 11 }, { ...ROW, id: 12 }] });

  const result = await h.claimer.onMail(ALERT);

  assert.equal(result.claimed, true);
  assert.equal(h.claims[0].id, 11);
  assert.match(h.events.at(-1).why, /identical rows/);
});

test('checkOnly proves the path without taking the shift', async () => {
  const h = harness({ config: { checkOnly: true } });
  const result = await h.claimer.onMail(ALERT);

  assert.equal(result.claimed, false);
  assert.equal(h.claims.length, 0, 'nothing was claimed');
  assert.equal(h.checks.length, 1, 'but the server was asked');
  assert.deepEqual(kinds(h.events), ['alert', 'checked']);
});

test('a claim that loses the race is recorded, not thrown', async () => {
  const h = harness({ claimResult: new Error('refused: "N/A"') });
  const result = await h.claimer.onMail(ALERT);

  assert.equal(result.claimed, false);
  assert.deepEqual(kinds(h.events), ['alert', 'error']);
  assert.match(h.events.at(-1).why, /refused/);
});

/* ---------- the rules ---------- */

test('the weekly cap holds', async () => {
  const held = [{
    id: 1, start: '2026-08-11T08:00:00', end: '2026-08-11T20:00:00', hours: 12,
  }];
  const h = harness({ mine: held, config: { maxHoursPerWeek: 16, minNoticeMinutes: 60 } });

  await h.claimer.onMail(ALERT);

  assert.equal(h.claims.length, 0);
  assert.match(h.events.at(-1).why, /16h weekly cap/);
});

test('two alerts in the same minute cannot both fill the last slot', async () => {
  // The schedule read is served from a five minute cache, so without remembering
  // what this process just claimed, the second alert sees a week with room.
  const second = {
    ...ALERT,
    body: ALERT.body.replace('12:45pm - 5:15pm', '6pm - 10:30pm'),
  };
  const later = {
    ...ROW, id: 999, start: '2026-08-13T18:00:00', end: '2026-08-13T22:30:00', hours: 4.5,
  };

  const h = harness({
    board: [ROW, later],
    config: { maxHoursPerWeek: 5, minNoticeMinutes: 60, minGapMinutes: 0 },
  });

  const first = await h.claimer.onMail(ALERT);
  const next = await h.claimer.onMail(second);

  assert.equal(first.claimed, true, '4.5h fits under a 5h cap');
  assert.equal(next.claimed, false, 'a second 4.5h does not');
  assert.match(h.events.at(-1).why, /weekly cap/);
});

test('a shift starting too soon is skipped', async () => {
  const h = harness({ config: { minNoticeMinutes: 300 } });
  await h.claimer.onMail(ALERT);

  assert.equal(h.claims.length, 0);
  assert.match(h.events.at(-1).why, /notice/);
});

test('the default notice is three hours, and that does skip some real alerts', () => {
  // Asked for: do not take a shift starting inside three hours. The cost is
  // known rather than guessed. Across the 56 captured alerts a 180 minute rule
  // keeps 48 and skips 8, and the captured 2026-08-13 mail is one of the 8: it
  // went out at 10:30 for a shift at 12:45, which is 135 minutes.
  const mailAt = new Date(2026, 7, 13, 10, 30).getTime();
  const verdict = judge(ROW, { mine: [], config: {}, now: mailAt });

  assert.equal(verdict.take, false, '135 minutes is inside a three hour rule');
  assert.match(verdict.why, /under the 180 min notice/);

  // Four hours out, the same shift is fine.
  const earlier = new Date(2026, 7, 13, 8, 45).getTime();
  assert.equal(judge(ROW, { mine: [], config: {}, now: earlier }).take, true);
});

test('an overlapping or back-to-back shift is refused', () => {
  const held = [{
    id: 7, start: '2026-08-13T16:00:00', end: '2026-08-13T20:00:00', hours: 4,
  }];

  assert.equal(judge(ROW, { mine: held, config: {}, now: NOW }).take, false, 'overlaps');

  const after = [{
    id: 8, start: '2026-08-13T17:15:00', end: '2026-08-13T21:15:00', hours: 4,
  }];
  const verdict = judge(ROW, { mine: after, config: { minGapMinutes: 480 }, now: NOW });
  assert.equal(verdict.take, false);
  assert.match(verdict.why, /under 480 min/);
});

test('a shift starting too soon costs no board read at all', async () => {
  // The mail already says when the shift starts, so reading the board to find
  // out would spend the one endpoint that rate limits on a shift that was never
  // going to be taken. Eight of the 56 real alerts fall here at a 3h rule.
  const h = harness({ config: { minNoticeMinutes: 180 } });
  const result = await h.claimer.onMail(ALERT); // 09:00 now, 12:45 start = 225 min

  assert.equal(result.claimed, true, '225 min of notice clears a 3h rule');

  // 12:45 is now only 2h away, which is inside the rule.
  const tight = createClaimerAt(new Date(2026, 7, 13, 10, 45).getTime(), {
    config: { minNoticeMinutes: 180 },
  });
  const outcome = await tight.claimer.onMail(ALERT);

  assert.equal(outcome.claimed, false);
  assert.deepEqual(tight.boardReads, [], 'the board must not be touched');
  assert.match(tight.events.at(-1).why, /notice.*no board read/);
});

test('every real shift length clears the rules, since none is short', () => {
  // 4h x42, 4.25h x7, 4.5h x4 and 8h x3 across the 56 captured alerts. There is
  // deliberately no minimum-duration rule, because it could never fire.
  for (const hours of [4, 4.25, 4.5, 8]) {
    const verdict = judge({ ...ROW, hours }, { config: {}, now: NOW });
    assert.equal(verdict.take, true, `${hours}h should be claimable`);
  }
});

test('a bid or a trade is never claimed', () => {
  for (const mode of ['bid', 'trade', 'locked', 'mine']) {
    const verdict = judge({ ...ROW, mode }, { mine: [], config: {}, now: NOW });
    assert.equal(verdict.take, false, `${mode} must not be claimed`);
    assert.match(verdict.why, /not a one-click claim/);
  }
});

test('a cap of zero means zero, not "no cap"', () => {
  const verdict = judge(ROW, { mine: [], config: { maxHoursPerWeek: 0 }, now: NOW });
  assert.equal(verdict.take, false, 'setting the cap to 0 is a kill switch');
});

test('an unreadable held shift cannot buy cap room', () => {
  // NaN comparisons are all false, so a held shift with broken dates used to pass
  // every guard at once and drop its hours out of the week total.
  const broken = [
    { id: 1, start: null, end: null, hours: 12 },
    { id: 2, start: '2026-08-11T08:00:00', end: '2026-08-11T20:00:00', hours: 12 },
  ];
  const verdict = judge(ROW, { mine: broken, config: { maxHoursPerWeek: 16 }, now: NOW });

  assert.equal(verdict.take, false, 'the readable 12h shift still counts');
});

test('matchShift compares instants, not strings', () => {
  // The board may render the same moment with milliseconds or a different
  // separator. Matching on the string would miss the shift and look like a lost
  // race.
  const { row } = matchShift(
    [{ ...ROW, start: '2026-08-13T12:45:00.000', end: '2026-08-13T17:15:00.000' }],
    { start: '2026-08-13T12:45:00', end: '2026-08-13T17:15:00', station: 'Hamper Station Duty' },
  );

  assert.equal(row?.id, ROW.id);
});
