#!/usr/bin/env bash
#
# Sets up the RSO availability tool. Safe to run again, it skips whatever is
# already done.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="tmwork-rso"
URL="http://127.0.0.1:8123"

say() { printf '%s\n' "$*"; }
ok()  { printf '  ok   %s\n' "$*"; }
skip(){ printf '  --   %s\n' "$*"; }

say "RSO availability setup"
say

# --- node ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  say "node is not installed. See PREREQUISITES.md."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  say "node $NODE_MAJOR is too old, need 18+. See PREREQUISITES.md."
  exit 1
fi
ok "node $(node --version)"

# --- deps ---------------------------------------------------------------
if [ -d "$DIR/node_modules" ]; then
  skip "dependencies already installed"
else
  say "  ...  installing dependencies"
  (cd "$DIR" && npm install --silent)
  ok "dependencies"
fi

# --- config -------------------------------------------------------------
if [ -f "$DIR/config.json" ]; then
  EMP="$(node -p "require('$DIR/config.json').employeeUser")"
  skip "config.json exists (employee $EMP)"
else
  printf '  Employee number: '
  read -r EMP
  printf '  Location name [RSO Boston]: '
  read -r LOC
  LOC="${LOC:-RSO Boston}"
  printf '  Employee code [Resident]: '
  read -r CODE
  CODE="${CODE:-Resident}"

  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$DIR/config.example.json', 'utf8'));
    c.employeeUser = '$EMP';
    c.template = '$LOC';
    c.employeeCode = '$CODE';
    fs.writeFileSync('$DIR/config.json', JSON.stringify(c, null, 2) + '\n');
  "
  ok "config.json"
fi

# --- password -----------------------------------------------------------
# Keychain only. It never lands in a file, and -w with no value makes the
# prompt come from `security` itself, so it stays out of shell history.
if security find-generic-password -s "$SERVICE" -a "$EMP" >/dev/null 2>&1; then
  skip "password already in Keychain"
else
  say "  Your TeamWork password. Goes into the macOS Keychain, not a file."
  security add-generic-password -U -s "$SERVICE" -a "$EMP" -w
  ok "password stored in Keychain"
fi

# --- the rso command ----------------------------------------------------
RC="$HOME/.zshrc"
if [ -f "$RC" ] && grep -q '^rso()' "$RC"; then
  skip "rso already in ~/.zshrc"
else
  cat >> "$RC" <<EOF

# rso -- cd to the availability project, start the local server, open the UI.
# A function rather than an alias so it can skip the restart when it is already
# running, and hold the browser back until the server actually answers.
rso() {
  local dir="$DIR"
  local url="$URL"

  if [[ ! -d "\$dir" ]]; then
    print -u2 "rso: \$dir not found"
    return 1
  fi
  cd "\$dir" || return 1

  # Already up: bring the browser to it instead of failing on a port collision.
  if curl -sf -o /dev/null --max-time 1 "\$url"; then
    echo "rso: already running at \$url"
    open "\$url"
    return 0
  fi

  # Open the browser only once the server answers, so we never land on a
  # connection-refused page. Gives up after ~15s rather than looping forever if
  # the server fails to boot. &! backgrounds and disowns.
  ( for _ in {1..50}; do
      curl -sf -o /dev/null --max-time 1 "\$url" && { open "\$url"; break; }
      sleep 0.3
    done ) &!

  echo "rso: starting server, browser will open at \$url (Ctrl+C to stop)"
  npm start
}
EOF
  ok "rso added to ~/.zshrc"
fi

say
say "Done. Open a new terminal and run:"
say
say "  rso"
say
