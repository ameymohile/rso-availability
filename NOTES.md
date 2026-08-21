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

## Not built

**Open-shift rows** have never been rendered against a real SwapBoard object. They assume the same `Start` / `End` / `Hours` / `StnName` fields as calendar shifts, which is likely but unproven.

**Specific time ranges** like 09:00-17:00. Only all-day and off. Every save I have made used All Day, so the wire format for `TimeSlot.Start` was never captured.

**Overrides**, the date-specific exceptions screen. Not captured.

**Anything unattended.** It only watches while the page is open, so a drop while the laptop is shut still gets missed. That was deliberate. A background watcher that claims on its own needs guardrails I have not built: overlap checks, weekly caps, blackout dates, a kill switch.
