// Against the real message, then against the ways it could go wrong.
//
// The first test is the actual email from 2026-08-13, transcribed. Everything
// else exists because a parse that half-works hands the claimer a shift that is
// not the one in the email, and the claim commits Amey to real work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlert, minutesOf, normalise, unwrapSafeLink } from './alert.mjs';

const REAL = {
  from: 'mailer@schedulesource.com <mailer@schedulesource.com>',
  subject: 'TeamWork ALERT: SHIFT AVAILABLE',
  body: `SHIFT AVAILABLE:

[RSO Boston][Hamper Station Duty]
Thursday, 08/13/2026  12:45pm - 5:15pm

BY: Mehta, Aryan

--- TEAMWORK ---
https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Ftmwork.net%2F&data=05%7C02%7Cmohile.a%40northeastern.edu&reserved=0`,
};

test('the real email parses into the shift it describes', () => {
  const { shift, ignored } = parseAlert(REAL);

  assert.equal(ignored, null);
  assert.equal(shift.location, 'RSO Boston');
  assert.equal(shift.station, 'Hamper Station Duty');
  assert.equal(shift.start, '2026-08-13T12:45:00');
  assert.equal(shift.end, '2026-08-13T17:15:00');
  assert.equal(shift.date, '2026-08-13');
  assert.equal(shift.hours, 4.5);
  assert.equal(shift.releasedBy, 'Mehta, Aryan');
});

test('an evening shift ending at midnight lands on the next day', () => {
  // 8pm-12am is the ordinary C2 block here, so this is the common case. Reading
  // the end as 00:00 on the *start* date would make it a negative-length shift
  // and every guardrail downstream would compare against nonsense.
  const { shift } = parseAlert({
    ...REAL,
    body: REAL.body.replace('Thursday, 08/13/2026  12:45pm - 5:15pm', 'Thursday, 08/13/2026  8pm - 12am'),
  });

  assert.equal(shift.start, '2026-08-13T20:00:00');
  assert.equal(shift.end, '2026-08-14T00:00:00');
  assert.equal(shift.hours, 4);
  assert.equal(shift.date, '2026-08-13', 'the board is read for the day it starts');
});

test('times on the hour parse as well as times with minutes', () => {
  // TeamWork writes "8pm" and "12:45pm" from the same formatter depending on
  // whether the time lands on the hour, so both shapes turn up in real mail.
  assert.equal(minutesOf('12am'), 0);
  assert.equal(minutesOf('12pm'), 720);
  assert.equal(minutesOf('8pm'), 1200);
  assert.equal(minutesOf('12:45pm'), 765);
  assert.equal(minutesOf('5:15pm'), 1035);
  assert.equal(minutesOf('8:30am'), 510);
});

test('a nonsense time is refused rather than guessed at', () => {
  assert.equal(minutesOf('25pm'), null);
  assert.equal(minutesOf('0am'), null);
  assert.equal(minutesOf('8:75pm'), null);
  assert.equal(minutesOf('noon'), null);
});

test('HTML mail with nbsp parses the same as plain text', () => {
  // Outlook hands back HTML to some clients, and the double space in the date
  // line arrives as &nbsp;. Left alone, the date regex misses and a real posting
  // is silently ignored.
  const html = `<div>SHIFT AVAILABLE:</div><div><br></div>
<div>[RSO Boston][Hamper Station Duty]</div>
<div>Thursday,&nbsp;08/13/2026&nbsp;&nbsp;12:45pm - 5:15pm</div>
<div><br></div><div>BY: Mehta, Aryan</div>`;

  const { shift, ignored } = parseAlert({ ...REAL, body: html });

  assert.equal(ignored, null);
  assert.equal(shift.station, 'Hamper Station Duty');
  assert.equal(shift.start, '2026-08-13T12:45:00');
});

test('trailing whitespace does not defeat the line anchors', () => {
  const padded = REAL.body
    .replace('[RSO Boston][Hamper Station Duty]', '[RSO Boston][Hamper Station Duty]   ')
    .replace('12:45pm - 5:15pm', '12:45pm - 5:15pm  ');

  assert.equal(parseAlert({ ...REAL, body: padded }).ignored, null);
});

test('a different TeamWork alert does not become a claim', () => {
  // The gate is the whole subject, not the word ALERT. Firing a claim at a
  // schedule-published notice would send a claim for a shift nobody offered.
  for (const subject of [
    'TeamWork ALERT: SCHEDULE PUBLISHED',
    'TeamWork ALERT: SHIFT TAKEN',
    'TeamWork ALERT',
    'FW: TeamWork ALERT: SHIFT AVAILABLE — see below',
  ]) {
    const { shift, ignored } = parseAlert({ ...REAL, subject });
    assert.equal(shift, null, `${subject} must not parse`);
    assert.match(ignored, /subject/);
  }
});

test('the right subject from the wrong sender is ignored', () => {
  // This arrives in a university mailbox anybody can write to, and the payload
  // decides which shift gets claimed.
  const { shift, ignored } = parseAlert({ ...REAL, from: 'someone@example.com' });

  assert.equal(shift, null);
  assert.match(ignored, /sender/);
});

test('a body missing the pieces is ignored with the reason', () => {
  assert.match(parseAlert({ ...REAL, body: 'SHIFT AVAILABLE:\n\nsomething else entirely' }).ignored, /location/);
  assert.match(
    parseAlert({ ...REAL, body: '[RSO Boston][Hamper Station Duty]\n\nsoon-ish' }).ignored,
    /date and time/,
  );
});

test('SafeLinks unwrapping survives for the day a link carries an id', () => {
  assert.equal(
    unwrapSafeLink('https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Ftmwork.net%2Femp%2F%23%21sch-swapboard&data=05'),
    'https://tmwork.net/emp/#!sch-swapboard',
  );
  // A plain link is handed back untouched rather than mangled.
  assert.equal(unwrapSafeLink('https://tmwork.net/'), 'https://tmwork.net/');
});

test('normalise leaves a plain body alone apart from line endings', () => {
  assert.equal(normalise('a\r\nb'), 'a\nb');
});
