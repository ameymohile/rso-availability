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

## Not built

**Claiming a shift.** The write has never been observed and I am not guessing at a request that commits me to a shift. The button opens TeamWork for now. To finish it: when something is actually on the board, run `node recon.mjs`, claim it by hand, quit the browser, and the capture has the request.

**Open-shift rows** have never been rendered against a real SwapBoard object. They assume the same `Start` / `End` / `Hours` / `StnName` fields as calendar shifts, which is likely but unproven.

**Specific time ranges** like 09:00-17:00. Only all-day and off. Every save I have made used All Day, so the wire format for `TimeSlot.Start` was never captured.

**Overrides**, the date-specific exceptions screen. Not captured.

**Anything unattended.** It only watches while the page is open, so a drop while the laptop is shut still gets missed. That was deliberate. A background watcher that claims on its own needs guardrails I have not built: overlap checks, weekly caps, blackout dates, a kill switch.
