// Writes shifts into Calendar.app via AppleScript.
//
// Calendar refuses to subscribe to a plain-HTTP loopback URL, so the automatic
// path cannot be a feed it fetches. Writing into a calendar that already syncs
// to Google means the shifts reach the phone too.
//
// Two things learned the hard way:
//   - `make new calendar` returns an id but does not persist, so the target
//     calendar has to already exist.
//   - Deleting a whole date window would take real events with it, so deletes
//     are scoped to summaries we wrote.

import { spawn } from 'node:child_process';

const PREFIX = 'RSO ';

const quote = (value) => `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// Parsing dates from text is locale-dependent, so build them from components.
// Day resets to 1 first or setting the month can overflow, e.g. the 31st.
function dateLines(name, value) {
  const d = new Date(value);
  return [
    `set ${name} to current date`,
    `set day of ${name} to 1`,
    `set year of ${name} to ${d.getFullYear()}`,
    `set month of ${name} to ${d.getMonth() + 1}`,
    `set day of ${name} to ${d.getDate()}`,
    `set time of ${name} to ${d.getHours() * 3600 + d.getMinutes() * 60}`,
  ];
}

function run(source) {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-']);
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.stderr.on('data', (chunk) => { err += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0
      ? resolve(out.trim())
      : reject(new Error(err.trim() || `osascript exited ${code}`))));
    proc.stdin.end(source);
  });
}

const summaryFor = (shift) => `${PREFIX}· ${shift.station ?? 'shift'}`;

function script(shifts, name, from, to) {
  const events = shifts.flatMap((shift, i) => [
    ...dateLines(`s${i}`, shift.start),
    ...dateLines(`e${i}`, shift.end),
    `make new event at end with properties {summary:${quote(summaryFor(shift))}`
      + `, start date:s${i}, end date:e${i}`
      + `, location:${quote(shift.location ?? shift.station ?? '')}`
      + `, description:${quote(`${shift.hours}h shift`)}}`,
  ]);

  return [
    'tell application "Calendar"',
    `  set cal to first calendar whose name is ${quote(name)}`,
    ...dateLines('windowStart', from).map((l) => `  ${l}`),
    ...dateLines('windowEnd', to).map((l) => `  ${l}`),
    '  tell cal',
    // Scoped to our own summaries. Without this, pointing at a real calendar
    // would delete real events.
    `    delete (every event whose start date is greater than or equal to windowStart`
      + ` and start date is less than or equal to windowEnd`
      + ` and summary begins with ${quote(PREFIX)})`,
    ...events.map((l) => `    ${l}`),
    '  end tell',
    'end tell',
  ].join('\n');
}

export async function syncCalendar(shifts, { name } = {}) {
  if (process.platform !== 'darwin') throw new Error('Calendar sync is macOS only');
  if (!name) throw new Error('No calendar name configured');
  if (!shifts.length) return { synced: 0, calendar: name };

  const found = await run(
    `tell application "Calendar" to return (count of (calendars whose name is ${quote(name)}))`,
  );
  if (found === '0') {
    throw new Error(`No calendar named "${name}" in Calendar.app. Check the name in config.json.`);
  }

  // The window must cover everything we might have written, not just what we
  // are writing now, or a shift outside it gets re-added on every run and
  // duplicates. Today is included so a dropped upcoming shift still clears.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = new Date(Math.min(today.getTime(), ...shifts.map((s) => s.at)));
  from.setHours(0, 0, 0, 0);
  const to = new Date(Math.max(today.getTime(), ...shifts.map((s) => s.at)) + 86400000);

  await run(script(shifts, name, from, to));
  return { synced: shifts.length, calendar: name };
}
