// Measures the API instead of arguing about it.
//
// The claim that matters for winning a race is "endpoint X reflects a new
// posting sooner than endpoint Y", and every such claim in NOTES.md is currently
// read off their client source or inferred from one browser capture. Two of them
// are already known to be wrong or unexplained:
//
//   - The 1.5s floor is per endpoint, not per session. In recon-out/network.json
//     the browser fires swapboardCounts, emplist and swapboard in the same
//     millisecond and all three answer 200, then emplist answers 200 at 0.5s
//     spacing while swapboard answers 400 at the same instants. So a second
//     detector on a different endpoint costs nothing against the board's budget.
//   - swapboardCounts answered 400 to this client 170 times on 2026-08-21 with
//     an empty body, at the same URL the browser gets a 200 from. Something in
//     the request differs and it is not the path.
//
// This file answers both by asking the server, and answers nothing by reasoning.
// It never claims a shift and it never writes.
//
// Usage:
//   node probe.mjs                     print the plan, send nothing
//   node probe.mjs --run               one call per lane: status, latency, shape
//   node probe.mjs --run --bisect      which header makes swapboardCounts a 200
//   node probe.mjs --run --floor       find each lane's real minimum spacing
//   node probe.mjs --run --watch=600   poll every lane for 600s, log what each
//                                      one saw and when
//
// --floor and --watch deliberately push at rate limits. The swapboard endpoint
// is excluded from both by default, because its refusals are the ones that cost
// real shifts: every 400 restarts the "30 minutes idle required for reset"
// clock. --include-board opts in, and if you do that, stop the launchd agent
// first so the bot is not spending the same budget.

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { connect, isoDate } from './tmwork.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

const OUT = fileURLToPath(new URL('./probe-out/', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Descending, and coarse at the top because the interesting region is the
// bottom. Four calls per step: one 200 proves nothing, and a lane that refuses
// only the fourth call is a burst limit rather than a spacing limit.
const SPACINGS = [3000, 2000, 1500, 1200, 1000, 800, 600, 450, 300, 200];
const CALLS_PER_SPACING = 4;
// Long enough that a burst counter from the previous step has drained. Guessed,
// not measured, which is why a lane that fails at every spacing including the
// widest is reported as inconclusive rather than as a 3s floor.
const COOLOFF_MS = 5000;
const BETWEEN_LANES_MS = 10000;
// Two calls per header variant. One 200 could be luck, one 400 could be a
// throttle from the variant before it.
const BISECT_TRIES = 2;

const firstOfMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

const calendarQuery = (showSwap) => new URLSearchParams({
  selectedDate: isoDate(new Date()),
  currentView: 'week',
  showSchedule: 'true',
  showTime: 'false',
  showAvailability: 'false',
  showDaysOff: 'true',
  showEvents: 'false',
  showSwap: String(showSwap),
  weekStart: '0',
});

// The browser adds a cache buster to every one of these. Ours never has, and an
// intermediary answering from cache would look exactly like an endpoint that
// lags, so the probe matches the browser rather than leaving it as a variable.
const bust = () => `_=${Date.now()}`;

// `signal` is the number that changes when a shift is posted. It is what a
// detector would actually watch, so it is what the lag between two lanes is
// measured on. Returning null means "this lane cannot see postings at all",
// which is a result and not an error.
const LANES = [
  {
    name: 'swapboard-week',
    what: 'the grid itself, week range. The truth every other lane is judged against.',
    url: () => `/api/shift/swapboard?date=${isoDate(new Date())}&range=week&${bust()}`,
    floorSafe: false,
    signal: (rows) => (Array.isArray(rows) ? rows.map((r) => r.Id).sort().join(',') : null),
  },
  {
    name: 'swapboard-month',
    what: 'what the sweep reads today. Same endpoint, wider range, so a slower query.',
    url: () => `/api/shift/swapboard?date=${isoDate(new Date())}&range=month&${bust()}`,
    floorSafe: false,
    signal: (rows) => (Array.isArray(rows) ? rows.map((r) => r.Id).sort().join(',') : null),
  },
  {
    name: 'counts',
    what: '84 days of per-day SwapCount in one call. Wide and cheap, if it can be made to answer.',
    url: () => `/api/shift/swapboardCounts?date=${isoDate(firstOfMonth())}&fillgaps=true&${bust()}`,
    floorSafe: true,
    signal: (rows) => (Array.isArray(rows)
      ? rows.reduce((sum, r) => sum + (r.SwapCount ?? 0), 0)
      : null),
  },
  {
    name: 'calendar-swap',
    what: 'the calendar read with showSwap=true. A different controller, so probably a different limiter.',
    url: () => `/api/employee/calendar/GetItems?${calendarQuery(true)}&${bust()}`,
    floorSafe: true,
    signal: (rows) => (Array.isArray(rows) ? rows.length : null),
  },
  {
    name: 'calendar-noswap',
    what: 'the same read with showSwap=false. The control: whatever the flag adds is the difference between these two.',
    url: () => `/api/employee/calendar/GetItems?${calendarQuery(false)}&${bust()}`,
    floorSafe: true,
    signal: (rows) => (Array.isArray(rows) ? rows.length : null),
  },
  {
    name: 'emplist',
    what: 'my own shifts. Proven unthrottled in the capture, so it is the reference for what "no limit" looks like.',
    url: () => `/api/shift/emplist?date1=${isoDate(new Date())}&range=week&${bust()}`,
    floorSafe: true,
    signal: (rows) => (Array.isArray(rows) ? rows.length : null),
  },
  {
    name: 'messages',
    what: 'the message centre. Worth one look in case a posting raises a notification here.',
    url: () => `/api/cpack/unconfirmed-messages?${bust()}`,
    floorSafe: true,
    signal: (rows) => (Array.isArray(rows) ? rows.length : null),
  },
];

// The bot's current header set, then one addition at a time, then the browser's
// exact set. Whichever is the first 200 names the missing header.
const HEADER_VARIANTS = [
  { name: 'current', headers: { accept: 'application/json' } },
  {
    name: '+x-requested-with',
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  },
  {
    name: '+referer',
    headers: { accept: 'application/json', referer: 'https://www.tmwork.net/emp/' },
  },
  {
    name: '+both',
    headers: {
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://www.tmwork.net/emp/',
    },
  },
  {
    name: 'browser-exact',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://www.tmwork.net/emp/',
      'sec-ch-ua': '"Chromium";v="151", "Not=A?Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    },
  },
];

// A refusal only tells us something if we can read what it said. An empty body
// on a 400 is itself the finding, so it is reported as such rather than blank.
const reason = (result) => {
  if (result.ok) return '';
  const body = (result.body ?? '').trim();
  return body ? body.slice(0, 90).replace(/\s+/g, ' ') : '(empty body)';
};

const parse = (result) => {
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.body);
  } catch {
    // A 200 carrying HTML is the session having been bounced to a login page,
    // which must not be read as an empty board.
    return undefined;
  }
};

const describe = (lane, result) => {
  const parsed = parse(result);
  if (parsed === undefined) return result.ok ? 'not JSON' : reason(result);
  const sig = lane.signal(parsed);
  const rows = Array.isArray(parsed) ? parsed.length : 0;
  return `${rows} rows, signal ${sig === null ? 'n/a' : sig}`;
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/* ---------- passes ---------- */

// One call per lane, spaced well clear of every known limit. Establishes what
// each lane answers at all, what it costs, and what its signal looks like right
// now, which is the baseline the watch pass compares against.
async function coverage(session) {
  const rows = [];

  for (const lane of LANES) {
    const result = await session.getRaw(lane.url());
    rows.push({
      lane: lane.name, status: result.status, ms: result.ms, detail: describe(lane, result),
    });
    console.log(`  ${lane.name.padEnd(18)} ${String(result.status).padEnd(4)} ${String(result.ms).padStart(5)}ms  ${describe(lane, result)}`);
    // Wider than the widest floor being probed, so this pass cannot be the
    // reason a later pass sees a refusal.
    await sleep(3000);
  }

  // The first row of each lane, kept whole. The field list is what decides
  // whether a lane can carry a claim (Id, LocId, CheckSum) or only detect, and
  // guessing at it is how the open-shift row format stayed a guess for weeks.
  const samples = {};
  for (const lane of LANES) {
    const result = await session.getRaw(lane.url());
    const parsed = parse(result);
    samples[lane.name] = {
      status: result.status,
      firstRow: Array.isArray(parsed) ? parsed[0] ?? null : parsed ?? null,
    };
    await sleep(3000);
  }
  await writeFile(`${OUT}samples.json`, JSON.stringify(samples, null, 2));

  return rows;
}

// Walks the spacing down until the lane refuses. The last spacing where every
// call answered 200 is the floor we can actually use.
async function floorOf(session, lane) {
  let best = null;

  for (const spacing of SPACINGS) {
    const latencies = [];
    let refusal = null;

    for (let i = 0; i < CALLS_PER_SPACING; i += 1) {
      if (i) await sleep(spacing);
      const result = await session.getRaw(lane.url());
      latencies.push(result.ms);
      if (!result.ok) {
        refusal = { status: result.status, why: reason(result), onCall: i + 1 };
        break;
      }
    }

    const line = `    ${String(spacing).padStart(5)}ms  `;
    if (refusal) {
      console.log(`${line}refused on call ${refusal.onCall}: ${refusal.status} ${refusal.why}`);
      // Stop at the first refusal. Pushing further only feeds whatever counter
      // just tripped, and the answer is already known.
      return { lane: lane.name, floorMs: best, refusedAt: spacing, refusal };
    }

    best = spacing;
    console.log(`${line}${CALLS_PER_SPACING}/${CALLS_PER_SPACING} ok, median ${median(latencies)}ms`);
    await sleep(COOLOFF_MS);
  }

  return { lane: lane.name, floorMs: best, refusedAt: null, refusal: null };
}

async function floors(session, includeBoard) {
  const results = [];

  for (const lane of LANES) {
    if (!lane.floorSafe && !includeBoard) {
      console.log(`  ${lane.name}: skipped, its refusals cost shifts (--include-board to probe it anyway)`);
      continue;
    }
    console.log(`  ${lane.name}`);
    results.push(await floorOf(session, lane));
    await sleep(BETWEEN_LANES_MS);
  }

  return results;
}

// Holds a rate rather than testing a gap.
//
// --floor found no spacing that counts refuses, down to 200ms, and yet 125
// consecutive calls at 1.01/s were all refused on 2026-08-21. Both can be true:
// four calls in a row says nothing about a ceiling counted over minutes. So this
// pass holds a rate steadily and waits to be turned away, which is the only
// shape of measurement that can find one.
//
// Descending, and it stops at the first refusal, so the last rate it completed
// is the one that is safe to run a detector at.
const SUSTAIN_RATES_MS = [2500, 2000, 1500, 1200, 1000];
const SUSTAIN_HOLD_MS = 60_000;

// Which header turns the 400 into a 200. Ordered from what we send today to
// what the browser sends, so the first 200 names the difference.
async function bisect(session) {
  const lane = LANES.find((l) => l.name === 'counts');
  const results = [];

  for (const variant of HEADER_VARIANTS) {
    const attempts = [];
    for (let i = 0; i < BISECT_TRIES; i += 1) {
      if (i) await sleep(3000);
      const result = await session.getRaw(lane.url(), { headers: variant.headers });
      attempts.push({ status: result.status, ms: result.ms, why: reason(result) });
    }

    const allOk = attempts.every((a) => a.status === 200);
    results.push({ variant: variant.name, allOk, attempts });
    console.log(`  ${variant.name.padEnd(18)} ${attempts.map((a) => a.status).join(' ')}  ${allOk ? 'ok' : attempts[0].why}`);
    await sleep(3000);
  }

  return results;
}

async function sustain(session, laneName, holdMs = SUSTAIN_HOLD_MS) {
  const lane = LANES.find((l) => l.name === laneName);
  if (!lane) throw new Error(`no lane called ${laneName}`);
  if (!lane.floorSafe) throw new Error(`${laneName} is a RACE lane, refusing to hold a rate against it`);

  const results = [];

  for (const spacing of SUSTAIN_RATES_MS) {
    const perMinute = Math.round(60_000 / spacing);
    const until = Date.now() + holdMs;
    const latencies = [];
    let sent = 0;
    let refusal = null;

    while (Date.now() < until) {
      const at = Date.now();
      const result = await session.getRaw(lane.url());
      sent += 1;
      latencies.push(result.ms);

      if (!result.ok) {
        refusal = { status: result.status, why: reason(result), afterRequests: sent };
        break;
      }

      await sleep(Math.max(0, spacing - (Date.now() - at)));
    }

    const line = `    ${String(spacing).padStart(5)}ms (${String(perMinute).padStart(2)}/min)  `;

    if (refusal) {
      console.log(`${line}refused after ${refusal.afterRequests} requests: ${refusal.status} ${refusal.why}`);
      results.push({ spacing, perMinute, sent, refusal, held: false });
      // Stop the moment it turns us away. Pushing to a tighter rate would only
      // feed a counter that has already tripped, and the answer is known: the
      // rate above this one is the ceiling.
      return results;
    }

    console.log(`${line}${sent} requests, no refusal, median ${median(latencies)}ms`);
    results.push({ spacing, perMinute, sent, refusal: null, held: true });
    // Long enough for a per-minute counter to drain before the next rate, so a
    // refusal is attributable to the rate being held and not to the one before.
    await sleep(90_000);
  }

  return results;
}

// Polls every lane on its own clock and records the instant each one's signal
// changed. When a shift is finally posted this is the whole answer: whichever
// lane logged the change first is the one worth racing on, and the gap between
// the lanes is the lead in milliseconds.
async function watch(session, seconds, includeBoard, spacings) {
  const file = `${OUT}watch.jsonl`;
  const until = Date.now() + seconds * 1000;
  const lanes = LANES.filter((l) => l.floorSafe || includeBoard);

  console.log(`  watching ${lanes.map((l) => l.name).join(', ')} for ${seconds}s`);
  console.log(`  changes land in ${file}`);

  const runLane = async (lane) => {
    const spacing = spacings[lane.name] ?? 3000;
    let last;
    let refusals = 0;

    while (Date.now() < until) {
      const at = Date.now();
      const result = await session.getRaw(lane.url());
      const parsed = parse(result);
      const sig = parsed === undefined ? `error ${result.status}` : lane.signal(parsed);

      if (last !== undefined && sig !== last) {
        const entry = {
          at: new Date(at).toISOString(), atMs: at, lane: lane.name, from: last, to: sig, ms: result.ms,
        };
        await appendFile(file, `${JSON.stringify(entry)}\n`);
        console.log(`  ${new Date(at).toISOString()} ${lane.name}: ${last} -> ${sig}`);
      }
      last = sig;

      // A lane that starts refusing is a lane whose spacing was too tight. Back
      // it off rather than hammering, and say so once.
      if (!result.ok) {
        refusals += 1;
        if (refusals === 1) console.log(`  ${lane.name} refused (${reason(result)}), backing off to 5s`);
      }

      // Spacing is measured from the start of the request, not from its reply,
      // so a slow answer does not push the next call late and leave the lane
      // polling slower than it was told to.
      const target = refusals ? Math.max(spacing, 5000) : spacing;
      await sleep(Math.max(0, target - (Date.now() - at)));
    }
  };

  await Promise.all(lanes.map(runLane));
}

/* ---------- cli ---------- */

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.split('=')[1];

const plan = [
  ['coverage', true, `${LANES.length * 2} calls, 3s apart`],
  ['bisect', has('--bisect'), `${HEADER_VARIANTS.length * BISECT_TRIES} calls at swapboardCounts, 3s apart`],
  ['floor', has('--floor'), `up to ${SPACINGS.length * CALLS_PER_SPACING} calls per lane, descending spacing`],
  ['sustain', Boolean(value('--sustain')), `holds ${SUSTAIN_RATES_MS.join('/')}ms at ${value('--sustain') ?? '<lane>'} for ${SUSTAIN_HOLD_MS / 1000}s each, stops on the first refusal`],
  ['watch', Boolean(value('--watch')), `${value('--watch') ?? 0}s of polling every safe lane`],
];

if (!has('--run')) {
  console.log('probe.mjs sends nothing without --run. It would have done:\n');
  for (const [name, on, cost] of plan) {
    console.log(`  ${on ? '[x]' : '[ ]'} ${name.padEnd(9)} ${cost}`);
  }
  console.log('\nLanes:');
  for (const lane of LANES) {
    console.log(`  ${lane.name.padEnd(18)} ${lane.floorSafe ? '        ' : 'RACE    '} ${lane.what}`);
  }
  console.log('\nRACE lanes are excluded from --floor and --watch unless --include-board.');
  console.log('Nothing here claims a shift or writes anything.');
  process.exit(0);
}

await mkdir(OUT, { recursive: true });

const session = await connect(config);
console.log('signed in\n');

const report = { at: new Date().toISOString() };

console.log('coverage');
report.coverage = await coverage(session);

if (has('--bisect')) {
  console.log('\nheader bisect on swapboardCounts');
  report.bisect = await bisect(session);
}

if (has('--floor')) {
  console.log('\nminimum spacing per lane');
  report.floors = await floors(session, has('--include-board'));
}

if (value('--sustain')) {
  console.log(`\nsustainable rate for ${value('--sustain')}`);
  report.sustain = { lane: value('--sustain'), steps: await sustain(session, value('--sustain')) };
  const safe = report.sustain.steps.filter((s) => s.held).at(-1);
  console.log(safe
    ? `\n  held ${safe.perMinute}/min (${safe.spacing}ms) without a refusal`
    : '\n  refused at the very first rate, so nothing here is safe to sustain');
}

await writeFile(`${OUT}report.json`, JSON.stringify(report, null, 2));
console.log(`\nwritten to ${OUT}report.json and ${OUT}samples.json`);

if (value('--watch')) {
  console.log('\nwatch');
  // Poll each lane at the floor this run measured, falling back to a spacing
  // wide enough to be safe on a lane that was never floor-tested.
  const spacings = Object.fromEntries(
    (report.floors ?? []).filter((f) => f.floorMs).map((f) => [f.lane, f.floorMs]),
  );
  await watch(session, Number(value('--watch')), has('--include-board'), spacings);
}
