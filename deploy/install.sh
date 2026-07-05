#!/usr/bin/env bash
# One-time setup for running the tracker 24/7 on a Linux server (Oracle
# Cloud, any VPS, a spare box). Installs two systemd units:
#
#   h3-tracker.service        runs `npm run watch`, restarts on crash/boot
#   h3-tracker-update.timer   every 5 min: pull origin/main, npm ci if deps
#                             changed, restart the tracker — only on change
#
# Run from your checkout, as the user who owns it:
#
#   cd ~/MCC-Halo-3-Custom-Games-Tracker
#   sudo deploy/install.sh
#
# Re-running is safe — it just rewrites the units (e.g. after moving the
# checkout or switching node versions).

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "run with sudo: sudo deploy/install.sh" >&2
  exit 1
fi

# The tracker runs as the user who invoked sudo (override: H3_USER=... sudo -E ...).
H3_USER="${H3_USER:-${SUDO_USER:-}}"
if [[ -z "$H3_USER" || "$H3_USER" == "root" ]]; then
  echo "couldn't determine a non-root user to run the tracker as." >&2
  echo "run via sudo from your normal account, or set H3_USER explicitly." >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SCRIPT_DIR/.." && pwd)

as_owner() {
  runuser -u "$H3_USER" -- "$@"
}

# Resolve node/npm through the user's login shell so nvm installs are found.
NPM=$(runuser -l "$H3_USER" -c 'command -v npm' || true)
if [[ -z "$NPM" ]]; then
  echo "npm not found for user $H3_USER — install Node 20+ first." >&2
  exit 1
fi
NODE_DIR=$(dirname "$NPM")
echo "user:  $H3_USER"
echo "repo:  $REPO"
echo "npm:   $NPM"

if [[ ! -f "$REPO/.env" ]]; then
  echo
  echo "note: $REPO/.env doesn't exist yet — the tracker will start with" >&2
  echo "defaults (no Discord). cp .env.example .env and fill it in." >&2
fi

if [[ ! -d "$REPO/node_modules" ]]; then
  echo "installing dependencies (npm ci)..."
  (cd "$REPO" && as_owner "$NPM" ci --no-audit --no-fund)
fi

render() { # render <template> <destination>
  sed -e "s|__USER__|$H3_USER|g" \
      -e "s|__REPO__|$REPO|g" \
      -e "s|__NODE_DIR__|$NODE_DIR|g" \
      -e "s|__NPM__|$NPM|g" \
      "$1" >"$2"
}

render "$SCRIPT_DIR/h3-tracker.service"        /etc/systemd/system/h3-tracker.service
render "$SCRIPT_DIR/h3-tracker-update.service" /etc/systemd/system/h3-tracker-update.service
cp     "$SCRIPT_DIR/h3-tracker-update.timer"   /etc/systemd/system/h3-tracker-update.timer

systemctl daemon-reload
systemctl enable --now h3-tracker.service
systemctl enable --now h3-tracker-update.timer

echo
echo "done. useful commands:"
echo "  systemctl status h3-tracker              # is the tracker up?"
echo "  journalctl -u h3-tracker -f              # live tracker logs"
echo "  journalctl -u h3-tracker-update          # what the updater did"
echo "  sudo systemctl start h3-tracker-update   # force an update check now"
