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

function harness({ board = [ROW], mine = [], config = {}, claimResult } = {}) {
  const claims = [];
  const checks = [];
  const events = [];
  const boardReads = [];

  const claimer = createClaimer({
    config: { minNoticeMinutes: 60, ...config },
    now: () => NOW,
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

test('the default notice would not have rejected the real alert', () => {
  // The captured mail went out at 10:30 for a shift at 12:45, so 135 minutes.
  // The old default of 180 threw exactly this shift away, which is the whole
  // thing this feature exists to catch.
  const mailAt = new Date(2026, 7, 13, 10, 30).getTime();
  const verdict = judge(ROW, { mine: [], config: {}, now: mailAt });

  assert.equal(verdict.take, true, 'a 135 minute alert must survive the defaults');
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

test('a shift shorter than the minimum costs no board read at all', async () => {
  // A two hour shift across town is not worth the trip, and the mail already
  // says it is two hours. Reading the board to find that out would spend the one
  // endpoint that rate limits on a shift we were never going to take.
  const alert = {
    ...ALERT,
    body: ALERT.body.replace('12:45pm - 5:15pm', '12:45pm - 2:45pm'),
  };

  const h = harness({ config: { minShiftHours: 3, minNoticeMinutes: 60 } });
  const result = await h.claimer.onMail(alert);

  assert.equal(result.claimed, false);
  assert.deepEqual(h.boardReads, [], 'the board must not be touched');
  assert.equal(h.claims.length, 0);
  assert.match(h.events.at(-1).why, /2h is under the 3h minimum \(no board read\)/);
});

test('a shift starting too soon also costs no board read', async () => {
  // Same reasoning: the start time is in the mail.
  const h = harness({ config: { minNoticeMinutes: 600 } });
  await h.claimer.onMail(ALERT);

  assert.deepEqual(h.boardReads, []);
  assert.match(h.events.at(-1).why, /notice.*no board read/);
});

test('the minimum is inclusive, and every real alert clears it', () => {
  // Inclusive: 3 means "3 hours or longer is fine".
  const exactly = { ...ROW, end: '2026-08-13T15:45:00', hours: 3 };
  assert.equal(judge(exactly, { config: { minShiftHours: 3 }, now: NOW }).take, true);

  // The durations actually seen across the 56 captured alerts. None is under 4h,
  // so a 3h floor changes nothing today and only guards the future.
  for (const hours of [8, 4, 4.25, 4.5]) {
    const verdict = judge({ ...ROW, hours }, { config: { minShiftHours: 3 }, now: NOW });
    assert.equal(verdict.take, true, `${hours}h should clear a 3h floor`);
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
