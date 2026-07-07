#!/usr/bin/env bash
# Pull the latest main and restart the tracker — but only when something
# actually changed. Run as root by h3-tracker-update.service (the timer fires
# it every 5 minutes); all git/npm work is dropped to the checkout's owner.
#
# Safe to run by hand:  sudo H3_USER=you H3_REPO=/path/to/checkout deploy/update.sh
#
# Behavior:
#   - no new commits on origin/main            -> exit quietly, no restart
#   - checkout not on main / local commits     -> refuse loudly (fix by hand)
#   - package.json or lockfile changed         -> npm ci before restarting
#   - a pull replaces this very script         -> harmless: the whole run is
#     parsed up front (main() below) before any code executes

set -euo pipefail

H3_USER="${H3_USER:?H3_USER not set (the user owning the checkout)}"
H3_REPO="${H3_REPO:?H3_REPO not set (path to the git checkout)}"
BRANCH="main"
SERVICE="h3-tracker"
LOCK="/run/h3-tracker-update.lock"

# Run a command in the repo as the checkout's owner.
as_owner() {
  runuser -u "$H3_USER" -- "$@"
}

main() {
  cd "$H3_REPO"

  local current_branch
  current_branch=$(as_owner git rev-parse --abbrev-ref HEAD)
  if [[ "$current_branch" != "$BRANCH" ]]; then
    echo "checkout is on '$current_branch', not '$BRANCH' — not auto-updating" >&2
    exit 1
  fi

  as_owner git fetch --quiet origin "$BRANCH"

  local local_rev remote_rev
  local_rev=$(as_owner git rev-parse HEAD)
  remote_rev=$(as_owner git rev-parse "origin/$BRANCH")
  if [[ "$local_rev" == "$remote_rev" ]]; then
    exit 0 # already current — the usual case, stay silent
  fi

  echo "updating: $local_rev -> $remote_rev"

  # --ff-only: if the server checkout has local commits or was force-pushed
  # over, fail here instead of merging/clobbering — that needs a human.
  as_owner git merge --ff-only --quiet "origin/$BRANCH"

  if ! as_owner git diff --quiet "$local_rev" "$remote_rev" -- package.json package-lock.json; then
    echo "dependencies changed — running npm ci"
    as_owner npm ci --no-audit --no-fund
  fi

  systemctl restart "$SERVICE"
  echo "restarted $SERVICE at $(as_owner git rev-parse --short HEAD)"
}

# flock so a slow npm ci can't overlap the next timer firing.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another update is already running — skipping" >&2
  exit 0
fi

main "$@"
exit 0
