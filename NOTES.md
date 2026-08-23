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
| `alert.mjs` | Parses the TeamWork alert email. Tested against a real one. |
| `claimer.mjs` | Alert in, one board read, one claim out. |
| `mail-alert.applescript` | The Apple Mail rule that fires the moment an alert lands. |

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

## The alert email

`mailer@schedulesource.com`, subject `TeamWork ALERT: SHIFT AVAILABLE`. Captured
2026-08-13:

```
SHIFT AVAILABLE:

[RSO Boston][Hamper Station Duty]
Thursday, 08/13/2026  12:45pm - 5:15pm

BY: Mehta, Aryan

--- TEAMWORK ---
https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Ftmwork.net%2F&...
```

What it does not carry matters more than what it does. **No shift id, no LocId,
and the only link is the site root**, so the mail cannot be claimed from
directly. It does pin the shift exactly, so one `swapboard?date=&range=day` turns
the description into the `Id` and `LocId` that `quick-claim` needs. One request
per alert, aimed at one day. Nothing polls.

Details that cost a rewrite if forgotten:

- The date line is `MM/DD/YYYY` with **two spaces** before the time, and the times
  come from the same formatter as everything else, so `8pm` and `12:45pm` both
  turn up. Outlook sends HTML to some clients with those spaces as `&nbsp;`.
- `8pm - 12am` means the end is the **next day**. Read as-is it is a
  negative-length shift and every guardrail downstream compares against nonsense.
- Outlook rewrites every link through SafeLinks, so if TeamWork ever does put an
  id in a link it arrives percent-encoded inside `url=`. `unwrapSafeLink` is there
  for that day, and that day removes the board read entirely.
- That mail gave **135 minutes of notice** (sent 10:30, shift at 12:45). The old
  `minNoticeMinutes: 180` would have thrown away exactly the shift this feature
  exists to catch. The default is 60 now.

### How late the mail is

Measured 2026-08-23 over all 56 alerts sitting in Apple Mail, comparing each
message's own `Date` header against when it was delivered:

```
min 3s   median 12s   mean 13.2s   p90 19s   p95 26s   max 38s
```

The header chain says where it goes:

```
Date:                             13 Aug 2026 09:11:56 -0600   schedulesource sends
X-MS-Exchange-...-OriginalArrivalTime: 13 Aug 2026 15:12:05    Microsoft receives   +9s
X-MS-Exchange-Transport-EndToEndLatency: 00:00:03.16           delivered            +3s
Received: from mail pickup service by aws-us2.schedulesource.com with Microsoft SMTPSVC
```

So most of it is schedulesource's own relay, not Microsoft's. That last line is an
IIS pickup directory: TeamWork writes a file and a service collects it later. None
of that is reachable from here, so **12s is a floor on this design, not something
to optimise.** On top of it sits whatever delay there is between the shift being
released and the mail being generated, which is invisible from outside.

What that means, plainly: a bot polling `api/shift/swapboard` at its 1.5s floor
sees a posting in about 0.75s on average. This route sees it in 12. It takes every
shift nobody else is actively racing, and loses every shift somebody is. That is
the honest ceiling, and no amount of work on our side moves it.

The parser is proven against all 56, not the one that was transcribed: 56/56, and
the real bodies cover `20:00-00:00` (the midnight rollover), `08:45-13:00` and
`12:45-17:15` (off-hour times with minutes), and station names carrying a `(2)`
suffix that matches the board's `StnName` exactly.

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
