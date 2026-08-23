# Notes

Reverse engineered from a recorded browser session. Here so future me can fix it when the site changes.

## Files

| File | What |
|---|---|
| `tmwork.mjs` | TeamWork client. Sign-in, template read/write, shifts. Shared. |
| `avail.mjs` | CLI. |
| `server.mjs` | Local server + JSON API. |
| `public/` | The UI. Vanilla HTML/CSS/JS, no build step. |
| `recon.mjs` | Traffic recorder, for when the site changes. |
| `probe.mjs` | Rate limit and latency probe. Measures the things below instead of inferring them. |
| `budget.mjs` | The only thing allowed to decide whether the board may be asked. |
| `detect.mjs` | Watches the counts endpoint so the rate-limited one is read only when something changed. |
| `http.mjs` | Keep-alive transport. Exists because `fetch` drops the socket between polls. |

## Auth

Sign in is a plain form POST. No SSO, no MFA, so it runs unattended.

```
GET  /signin                  -> scrape __RequestVerificationToken + antiforgery cookie
POST /SignIn?handler=EmpLogin -> portal, EmpCode, EmpUser, EmpPassword, __RequestVerificationToken
                                 302 to /emp/#!calendar, sets TMWORK session cookie
```

The API will not take cookies alone. It answers `Invalid Token` with a 401 no matter what headers you add. The session cookie is necessary and not sufficient. The shell embeds a per-session UUID:

```
GET /emp/  ->  body contains  APP.Token = '<uuid>'
```

That goes in the `x-api-token` header on every `/api/` call. Both the cookie and the header are required.

A wrong password re-renders the sign-in page instead of erroring, so failure is detected by `APP.Token` being absent.

## Availability

```
GET /api/avail/templates                     -> list, mine is "RSO Boston" id 3557
GET /api/avail/template/0/3557/?extraslots=2 -> the template
PUT /api/avail/template/0/                   -> save, send the whole object back
```

`Days` is 7 entries. `DayIndex` is 1 = Sunday through 7 = Saturday, checked against the rendered labels. All-day is `Enabled: true`, `Hours: 24`, every `TimeSlot` field left null. That is exactly what the real UI sends.

## Shifts

```
GET /api/shift/swapboardCounts?date=YYYY-MM-DD&fillgaps=true
GET /api/shift/swapboard?date=YYYY-MM-DD&range=day
GET /api/employee/calendar/GetItems?selectedDate=YYYY-MM-DD&currentView=week&...
GET /api/shift/emplist?date1=YYYY-MM-DD&range=week    (my own shifts, not open ones)
```

`swapboardCounts` returns ~84 days of per-day counts in one request, so an empty board costs one call. Only days with a non-zero `SwapCount` get a detail fetch.

Watch out: `ShiftCount` counts shifts I hold that day. `SwapCount` is what is actually claimable.

`/api/shift/swapboard` rate-limits. Faster than every 1.5s and it returns `400 "Please wait [1.5] seconds to refresh list."`, so detail fetches are spaced 1.6s apart.

## Claiming

Read out of their own client, not off the wire. The page modules are plain ES
modules served without auth, so they can be read directly:

```
/js/pages.js                    router: file = "/" + hash.replace("#!","") + ".js"
/emp/sch-swapboard.js           the SwapBoard view model, vm.QuickClaim
/emp/Editors/shift-claim.js     the "Check" modal
```

Three endpoints. Which one you use matters.

```
GET api/shift/swap/claim/?id=&bid=&checkSum=    asks, commits to nothing
PUT api/shift/swap/quick-claim?id=&bid=&schid=  takes it, one round trip
PUT api/shift/swap/claim?id=&bid=&schid=        takes it, needs SchId from the GET
PUT api/shift/swap/request?id=&bid=&schid=      when ApprovalRequired is set
```

`bid` is `LocId`, not a bid. `schid` is sent empty by the quick path; the split
claim flow is what fills it in.

**quick-claim needs no CheckSum.** `vm.QuickClaim` reads `data-cs` into a
variable and then never uses it. The GET check does need it.

**A 200 is not a success.** Their client treats a null result as claimed and
anything else as "N/A", so a 200 carrying a message is a refusal. Going by
status code alone records shifts as taken when they were not.

The GET check returns `CanSwap`, `ApprovalRequired`, `SchId` and a `Checks`
array. It commits to nothing, so it is the way to prove the path against a real
shift. `madmax.checkOnly: true` in config.json makes a sweep call it and log the
verdict instead of claiming.

## Picking which shifts to claim

Taking shifts greedily in date order loses hours. With 14h of room and an 8h, a
7h and a 7h on the board, greedy takes the 8 and then neither 7 fits: 8h banked
where 14h was available.

So `planBoard` solves it instead of scanning it. Weighted interval scheduling
with a per-week capacity, by DP over candidates sorted by start. The state is
(index, last taken, minutes spent this week); the last-taken index gives both
the earliest legal next start and the current week, because takes only move
forward. Memoisation is sparse, since reachable spends are subset sums of one
week's durations rather than every value up to the cap.

Verified against brute force over all subsets on 800 random boards (mixed caps,
gaps and station weights): identical value every time, and every plan legal. On
400 realistic boards it claims 7.4% more hours than the greedy pass and is never
worse.

`stationWeights` turns it from "most hours" into "most valuable hours".

Cap arithmetic is in whole minutes, both sides rounded the same way. Rounding the
candidate but not the remaining room used to refuse a shift that exactly filled
the week while `judge` accepted it. A roster schedules to the minute, so for real
`hours` values this is exact: 3000 fuzzed minute-granular boards produced zero
cap overage. Sub-minute durations (0.02h) can still slip under by a fraction of a
minute, which no roster produces.

Selection is by position, never by shift id. Filtering takes by id meant every
row sharing an id came back as taken, turning one pick into three claims.

A lost race triggers a re-plan. A shift passed over only because it clashed with
a claim that then failed is claimable again, so the sweep re-solves against what
actually landed, up to 3 rounds. The pool strictly shrinks each round.

## Rate limits

Three separate numbers, and only two are server-side.

- **30s.** Their own board refuses to re-read the counts endpoint inside 30
  seconds (`countData` in sch-swapboard.js). This is the sanctioned poll rate.
- **1.5s.** `api/shift/swapboard` answers 400 "Please wait [1.5] seconds to
  refresh list." Detail fetches are spaced 1.6s apart.
- **30 minutes.** 400 "Swap list disabled. (30) minutes idle required for
  reset." revokes the board until nothing has asked for 30 straight minutes.
  Every retry restarts that clock, so the only correct response is silence.

`data-expiry="30"` and `data-delay="1500"` on `#page-swapboard-container` are
not those limits. `expiry` is a 30 *second* sessionStorage cache TTL and `delay`
is a spinner delay. The numbers coincide; the meanings do not.

**The 1.5s is per endpoint, not per session.** In `recon-out/network.json` the
browser fires `swapboardCounts`, `emplist` and `swapboard` inside the same
millisecond (00:35:37.370) and all three answer 200. Then `emplist` answers 200
at 0.5s spacing five times running while `swapboard`, called at those same
instants, answers 400 "Please wait [1.5] seconds".

Measured per endpoint with `probe.mjs --run --floor` on 2026-08-21. Four calls at
each spacing from 3000ms down to 200ms:

| Endpoint | Refused at |
|---|---|
| `api/shift/swapboard` | 1.5s, declared and observed |
| `api/shift/swapboardCounts` | nothing, down to 200ms |
| `api/employee/calendar/GetItems` (either `showSwap`) | nothing, down to 200ms |
| `api/shift/emplist` | nothing, down to 200ms |
| `api/cpack/unconfirmed-messages` | nothing, down to 200ms |

**Only the board read is spacing-limited.** Everything else took 200ms without
complaint, which is the headroom the whole design now rests on.

### The counts 400s, and what they were not

`swapboardCounts` answered **400 with an empty body** 169 times on 2026-08-21.
Two hypotheses, both tested and both wrong:

- *A missing header.* `probe.mjs --bisect` tried the current header set, then
  `x-requested-with`, then `referer`, then both, then the browser's exact set.
  All five answered 200. It is not a header.
- *A bad `date`.* The failures all carried `date=2026-08-20`, and their client
  computes `DATEUTIL.FirstDayOfMonth`. Tested directly: `date=2026-08-21`
  (mid-month) answers 200. It is not the date.

What is left is the rate. The refusals were not spread out; they were two bursts
at **exactly 1.01 calls/sec**, 125 of them over 124s and then 44 more over 45s,
and the second burst was refused from its first call two minutes after the first
burst stopped. Against that, `--floor` sent 42 counts requests over ~90s, about
27/min, with no refusal at any spacing.

So counts has a **burst ceiling counted over minutes, not a spacing floor**. Four
calls in a row can never find it, which is why `--floor` says 200ms is fine and
125 calls at 1000ms were all refused. Somewhere between 27/min and 60/min it
turns us away, and it stays turned away for at least two minutes.

`probe.mjs --run --sustain=counts` is the instrument for the real number: it holds
one rate for a minute at a time, descending, and stops at the first refusal, so
the last rate it completes is the answer. Until that has been run, the detector
is set to 24/min, which is under what has been demonstrated.

## Why the lockout on 2026-08-21 happened

Not because one request was 100ms early. Because nothing in the system reacted to
a refusal.

`gate.mjs` spaced requests and `server.mjs` stood down for 31 minutes on "Swap
list disabled", but a plain 400 "Please wait [1.5] seconds to refresh list." was
caught, written to `madmax-log.jsonl` as `kind: "error"`, and then the next tick
went out on schedule at the same cadence that had just been refused. Refusals are
what escalate, and every one of them restarts TeamWork's 30 minute idle clock. We
were manufacturing them steadily and calling it an error log.

Three things fed the refusals at once, which is why 5s sweeps looked survivable
and were not:

- The sweep, every 5s.
- The page, polling `/api/open-shifts` every 60s, plus `R` by hand.
- Mail triggers, which can arrive at any instant including just after a tick.
- Deep sweeps, which make two requests where the accounting assumed one.

`budget.mjs` replaces "space the requests" with "own the allowance":

1. **Spacing.** 2500ms, delegated to `gate.mjs`, comfortably above the declared
   1500.
2. **Ceilings.** 8/min for routine polls, 12/min overall, 60 per 10 minutes. The
   gap between 8 and 12 is *reserved*: an empty board cannot spend the allowance
   that the one interesting moment needs.
3. **Backoff.** Any refusal buys silence, 10s then 30s then 2min then 10min for
   consecutive ones. A 500 or a dropped connection buys nothing, because neither
   is evidence about our rate.

A budget denial is logged as `kind: "held"`, not `"error"`, and does not disarm.
Being held is the system working.

The numbers are not derived from TeamWork's real thresholds, which are not
knowable from the client. They are small enough that the thresholds stop
mattering. Raise them only against measured output from `probe.mjs`.

## Latency

`www.tmwork.net` is an AWS ELB in **us-east-2**:
`app-lb-749987664.us-east-2.elb.amazonaws.com`, 18.220.148.222 / 52.14.69.245.

Measured from Boston on 2026-08-21: TCP connect 42-50ms, TLS complete 88-96ms
(so ~45ms per round trip), TTFB 130-150ms warm. A cold connection pays TCP plus
TLS, about 90ms, before the request is even sent.

Two consequences, both bigger than anything in the planner:

- A claim from a laptop here is ~45ms of flight time behind a claim from an
  instance in us-east-2. In a same-tick race that is the whole margin.
- The connection must be warm before the shift appears, or the claim pays 90ms
  of handshake on top. Node's undici pools per origin, so the session stays warm
  only as long as something keeps using it.

Node's `fetch` makes this worse than it looks. undici closes an idle socket after
about 3s (`keepAliveTimeout` 4000 minus `keepAliveTimeoutThreshold` 1000),
measured locally against a counting server: two requests 1s apart reuse one
connection, 3s apart open two. So at any sweep interval above ~3s **every request
pays a fresh TCP and TLS handshake**, and so does the claim. That is ~90ms thrown
away on the one request where 90ms is the whole race.

Fixing it needs the transport to hold its own keep-alive pool, which `fetch` does
not expose. `node:https` with an explicit `Agent` does, and would also let the
claim use a socket the polls never touch, so a claim can never queue behind an
in-flight board read. Not built.

## Where the race is actually won

In order of how much each is worth, measured or measurable:

1. **Be running.** 434 minutes of `gap` events on 2026-08-21 inside a 421 minute
   window: the laptop was asleep for effectively all of it. Nothing else on this
   list matters next to being absent.
2. **Detect on an endpoint that is not rate limited.** Built, see `detect.mjs`.
   `swapboardCounts` returns ~84 days of `SwapCount` in one request and is not
   spacing-limited, so it carries the frequency and the board endpoint is read
   only when a count actually moves. The changed day names the month, so that
   read is one aimed request. Measured effect: the board endpoint went from ~12
   routine requests/min to 2, with 8 urgent slots always free.
3. **Claim on a warm socket.** Built, see `http.mjs`. ~90ms.
4. **Move the process to us-east-2.** ~45ms per leg, and it ends the sleep gaps,
   which is the largest single loss on this list. Needs a password store that is
   not the macOS Keychain: `keychainPassword` falls back to `$TMWORK_PASSWORD`
   for exactly this.
5. **Claim without reading the board at all.** The open question, and the one
   worth the most. `api/employee/calendar/GetItems` carries `Id` and `LocId`,
   which is everything `quick-claim` needs, and it is not rate limited. If
   `showSwap=true` returns swap-board rows and not just my own shifts, detection
   and the claim credentials arrive on the same unthrottled request and the
   board endpoint is never touched. On an empty board `showSwap=true` and
   `showSwap=false` return identical rows, so this cannot be settled until
   something is posted. `probe.mjs --watch` logs both lanes side by side and
   answers it the first time a shift appears.
6. **Decide before the shift appears.** `planBoard` runs between detection and
   the claim. Real boards solve in under 25ms so this is small, but a
   precomputed "would I take a single shift like this" predicate makes it zero
   and the exact solve can follow the claim rather than precede it.

## No push channel exists

Checked, not assumed: `emp/sch-swapboard.js`, `js/pages.js`, `js/GLOBALS.js` and
the captured DOM contain no WebSocket, no SignalR, no EventSource, no long poll,
and no service worker. The board is `dsSwapShifts.read()` against
`api/shift/swapboard` and nothing else. There is no earlier feed to subscribe to
and no origin API behind the one we already call, so detection latency is bounded
by polling unless the notification comes from outside TeamWork entirely, which is
what `mailwatch.mjs` is for.

## Not built

**Open-shift rows** have still never been rendered against a live board, but the
field list is no longer a guess. The grid in the captured DOM declares
`LocName` `Date` `StnName` `ShiftGroup` `CliName` `StartSort` `EndSort`
`BreakStart` `BreakEnd` `Hours` `Notes` `EmpName`, and the action template needs
`Id` `LocId` `CheckSum` `CanSwap` `IsMe` `ToMe` `BidBoardId` `BidBoardStatus`
`DataType` `CanSplit` `SwapText`.

**Specific time ranges** like 09:00-17:00. Only all-day and off. Every save I have made used All Day, so the wire format for `TimeSlot.Start` was never captured.

**Overrides**, the date-specific exceptions screen. Not captured.

**A claim that has actually run.** Everything above is read out of their client
and unit tested against a fake session. Not one real request has been sent, so a
required header or a param I misread would only show up on the first live
attempt. `checkOnly` exists to make that first attempt harmless.
