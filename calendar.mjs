// Builds an iCalendar feed of shifts.
//
// Subscribed to rather than imported, so the calendar mirrors this feed: a
// moved shift updates in place and a dropped one disappears. Stable UIDs are
// what make that work, so they are derived from the TeamWork shift id.

const PRODID = '-//RSO availability//EN';
const REFRESH = 'PT15M';

// RFC 5545 escapes: backslash, semicolon, comma, newline.
const esc = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

// 20260816T000000Z. Shift times carry no zone, so Date parses them as local,
// which is correct: the server runs in the same timezone as the shifts.
const stamp = (date) => new Date(date)
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}/, '');

// Lines cap at 75 octets, continued with a leading space.
function fold(line) {
  if (line.length <= 75) return line;

  const chunks = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    chunks.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  if (rest) chunks.push(` ${rest}`);

  return chunks.join('\r\n');
}

function event(shift, now) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:rso-${shift.id}@tmwork.net`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(shift.start)}`,
    `DTEND:${stamp(shift.end)}`,
    `SUMMARY:${esc(shift.station ? `RSO · ${shift.station}` : 'RSO shift')}`,
    `DESCRIPTION:${esc(`${shift.hours}h shift`)}`,
  ];

  if (shift.location) lines.push(`LOCATION:${esc(shift.location)}`);
  if (shift.mapUrl) lines.push(`URL:${esc(shift.mapUrl)}`);

  lines.push('END:VEVENT');
  return lines;
}

export function buildCalendar(shifts, { name = 'RSO Shifts' } = {}) {
  const now = new Date();

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    // Both spellings exist in the wild; Apple reads one, others read the other.
    `REFRESH-INTERVAL;VALUE=DURATION:${REFRESH}`,
    `X-PUBLISHED-TTL:${REFRESH}`,
    ...shifts.flatMap((shift) => event(shift, now)),
    'END:VCALENDAR',
  ];

  return `${lines.map(fold).join('\r\n')}\r\n`;
}
