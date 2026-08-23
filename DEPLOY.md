# Running it with the lid closed

The claimer is triggered by an Apple Mail rule, and Mail does not receive mail
while the machine is asleep. Closing the lid sleeps the machine no matter what
`caffeinate` is holding: lid-close sleep ignores power assertions outright. So
with the lid shut, nothing fires and nothing is claimed.

Two answers, and they are not the same size.

## 1. Keep the Mac awake with the lid closed

Zero new infrastructure. Two ways.

**Clamshell.** Power adapter plus an external display and keyboard. macOS
officially stays awake with the lid shut. No sudo, nothing to undo, and it is the
supported path. If there is a monitor on the desk, this is the answer.

**Disable lid sleep on AC only.**

```sh
sudo pmset -c disablesleep 1     # lid closed + plugged in stays awake
pmset -g | grep SleepDisabled    # 1 = in force
sudo pmset -c disablesleep 0     # undo
```

`-c` matters. System-wide (`-a`) means a closed laptop stays awake in a bag on
battery, which is a hot laptop and a flat one. On AC only, it sleeps normally the
moment it is unplugged, which is the behaviour you want.

Either way the machine has to stay on the network, so this only covers "lid shut
on my desk", not "lid shut in my bag".

## 2. Run it somewhere that has no lid

The real fix. The claim path is portable already:

- `TMWORK_PASSWORD` stands in for the macOS Keychain.
- `calendar-sync.mjs` skips itself off macOS instead of failing.
- `notify.mjs` was already a no-op off macOS.
- `awake.mjs` was already a no-op off macOS.

What is **not** portable is the trigger. An Apple Mail rule needs Apple Mail, so a
box needs a different way to hear about the alert. Two options, and this is the
only real decision left:

### Option A: forward to Gmail, watch it over IMAP

Nothing can block this, because everything in it is yours.

1. Outlook rule (the server-side one, in Outlook web, not the Mail rule):
   forward mail from `mailer@schedulesource.com` to your Gmail.
2. Gmail app password.
3. The box holds an IMAP IDLE connection to Gmail and posts to `/api/alert`.

Cost: one more delivery hop, on top of the 12s median the alert already takes.

### Option B: Microsoft Graph

No extra hop, and it reads the Northeastern mailbox directly. Needs an Azure app
registration, which the university tenant may not permit for students. Either a
webhook, which needs a public HTTPS endpoint, or a delta poll every second or two,
which does not.

Neither option changes `alert.mjs` or `claimer.mjs`. They both end in the same
`POST /api/alert`, which is why the transport was kept behind that line.

## The box itself

A t4g.nano in **us-east-2** is about $3/month and is the same region as
`tmwork.net`'s load balancer (`app-lb-...us-east-2.elb.amazonaws.com`), which is
worth roughly 45ms per request against ~90ms from Boston. Any always-on Linux host
works; the region is a bonus, not a requirement.

```ini
# /etc/systemd/system/rso.service
[Unit]
Description=RSO shift claimer
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/rso
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production
# 600 and owned by this user. Not in the unit file, which is world readable.
EnvironmentFile=/etc/rso.env
StandardOutput=append:/var/log/rso.log
StandardError=append:/var/log/rso.log

[Install]
WantedBy=multi-user.target
```

```sh
# /etc/rso.env   chmod 600
TMWORK_PASSWORD=...
TMWORK_MAIL_PASSWORD=...
```

Set `claim.keepAwake: false` in `config.json` there. A server has no lid to hold
open and `caffeinate` does not exist.

One thing to get right: **only one of them may be live at a time.** Two claimers
on the same account both reading the board is two requests where the rate limit
allows one, and the endpoint that punishes that is the one that took a 30 minute
lockout on 2026-08-21. Switch the Mac's panel off before switching the box on.
