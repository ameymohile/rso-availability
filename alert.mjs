// Turns a TeamWork alert email into the shift it is talking about.
//
// The whole claimer hangs off this, so it is written against a real message
// rather than a guess. One captured on 2026-08-13:
//
//   From:    mailer@schedulesource.com
//   Subject: TeamWork ALERT: SHIFT AVAILABLE
//
//   SHIFT AVAILABLE:
//
//   [RSO Boston][Hamper Station Duty]
//   Thursday, 08/13/2026  12:45pm - 5:15pm
//
//   BY: Mehta, Aryan
//
//   --- TEAMWORK ---
//   https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Ftmwork.net%2F&...
//
// What matters is what is *not* in it. There is no shift id, no LocId, and the
// only link is the site root, so the email cannot be claimed from directly. What
// it does carry is enough to identify the shift exactly: location, station, date,
// start and end. So the claimer reads the board once for that single date and
// matches on those, which is one request instead of a poll.
//
// Everything here is deliberately strict. A parse that half-works would hand the
// claimer a shift that is not the one in the email, and the claim commits Amey to
// real work. Anything unrecognised comes back as ignored, with the reason.

// Only this one alert may trigger a claim. TeamWork sends other ALERT mails and
// a subject match of merely "ALERT" would fire a claim at a schedule-published
// notice. Anchored to the end so "SHIFT AVAILABLE CANCELLED", if it exists, does
// not match.
const SUBJECT = /\bALERT:\s*SHIFT AVAILABLE\s*$/i;

// The sender is part of the gate. Subject lines are trivially spoofable and this
// one arrives in a university mailbox that anybody can write to.
const SENDER = /(^|[<@.\s])schedulesource\.com\b/i;

// [RSO Boston][Hamper Station Duty]
const PLACE = /^\[([^\]\n]+)\]\[([^\]\n]+)\]\s*$/m;

// Thursday, 08/13/2026  12:45pm - 5:15pm
// Minutes are optional because TeamWork writes "8pm" and "12:45pm" from the same
// formatter, depending on whether the time lands on the hour.
const WHEN = /^\w+day,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}(?::\d{2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{2})?\s*[ap]m)\s*$/im;

// BY: Mehta, Aryan
const RELEASED_BY = /^BY:\s*(.+?)\s*$/m;

const pad = (n) => String(n).padStart(2, '0');

// Outlook hands back HTML for some clients and text for others, with nbsp for
// the double space in the date line. Normalising once here means every regex
// above can assume plain text and single spaces.
export function normalise(raw = '') {
  const text = /<\/?[a-z][^>]*>/i.test(raw)
    ? raw
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/\s*(p|div|tr|li|h\d)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
    : raw;

  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    // Trailing spaces would defeat the $ anchors above.
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

// "12:45pm" -> 765, "12am" -> 0, "12pm" -> 720.
export function minutesOf(label) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*([ap])m$/i.exec(label.trim());
  if (!match) return null;

  const [, rawHour, rawMinutes, half] = match;
  const hour = Number(rawHour);
  const minutes = Number(rawMinutes ?? 0);

  // 12am is hour 0 and 12pm is hour 12, which is the one case where the
  // arithmetic is not just "add twelve for pm".
  if (hour < 1 || hour > 12 || minutes > 59) return null;
  const hour24 = (hour % 12) + (half.toLowerCase() === 'p' ? 12 : 0);

  return hour24 * 60 + minutes;
}

// Local wall-clock ISO, without a zone, because that is the shape TeamWork's own
// API returns: "2026-08-15T20:00:00". Comparing those as strings only works if we
// build them the same way, and toISOString() would shift an evening shift into
// the next day.
const stamp = (year, month, day, minutes) => {
  const at = new Date(year, month - 1, day, 0, 0, 0, 0);
  at.setMinutes(minutes);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `T${pad(at.getHours())}:${pad(at.getMinutes())}:00`;
};

const ignored = (why) => ({ shift: null, ignored: why });

export function parseAlert({ from = '', subject = '', body = '' } = {}) {
  if (!SENDER.test(from)) return ignored(`sender is not TeamWork (${from || 'no from'})`);
  if (!SUBJECT.test(subject)) return ignored(`subject is not a shift alert (${subject || 'no subject'})`);

  const text = normalise(body);

  const place = PLACE.exec(text);
  if (!place) return ignored('no [location][station] line');

  const when = WHEN.exec(text);
  if (!when) return ignored('no recognisable date and time line');

  const [, location, station] = place;
  const [, month, day, year, startLabel, endLabel] = when;

  const startMinutes = minutesOf(startLabel);
  const endMinutes = minutesOf(endLabel);
  if (startMinutes === null || endMinutes === null) {
    return ignored(`could not read the times (${startLabel} to ${endLabel})`);
  }

  // A shift ending at or before it starts has run past midnight. 8pm-12am is the
  // ordinary evening block here, so this is the common case and not an edge one.
  const endsNextDay = endMinutes <= startMinutes;

  const start = stamp(Number(year), Number(month), Number(day), startMinutes);
  const end = stamp(Number(year), Number(month), Number(day), endMinutes + (endsNextDay ? 1440 : 0));

  return {
    ignored: null,
    shift: {
      location,
      station,
      start,
      end,
      // The date the board has to be read for, which is the start date even when
      // the shift finishes the following morning.
      date: start.slice(0, 10),
      hours: Number((((endsNextDay ? endMinutes + 1440 : endMinutes) - startMinutes) / 60).toFixed(2)),
      // Who put it up. Not used to match, because the board may render a name
      // differently, but logged so a mismatch is visible.
      releasedBy: RELEASED_BY.exec(text)?.[1] ?? null,
    },
  };
}

// Outlook rewrites every link through SafeLinks, so a URL that did carry
// parameters would arrive percent-encoded inside `url=`. Nothing needs this yet:
// the captured mail links only to the site root. It is here because the moment
// TeamWork does put a shift id in a link, this is the only thing standing between
// that and a claim with no board read at all.
export function unwrapSafeLink(url = '') {
  const match = /[?&]url=([^&]+)/.exec(url);
  if (!match || !/safelinks\.protection\.outlook\.com/i.test(url)) return url;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return url;
  }
}
