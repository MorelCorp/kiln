#!/usr/bin/env bash
# Update the Kiln clone this daemon runs from to origin/main, rebuild, and restart the service.
# Run from Kiln's Environments page (it is this project's deploy command) or by hand.
# Refuses to run in a checkout with local changes or on a branch other than main: use a dedicated
# deploy clone (see scripts/install-service.sh), not your development checkout.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Local changes in $(pwd): refusing to update. This should be a deploy clone." >&2
  exit 1
fi
if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "Not on main: refusing to update." >&2
  exit 1
fi

before="$(git rev-parse --short HEAD)"
git fetch --quiet origin main
git merge --ff-only --quiet origin/main
after="$(git rev-parse --short HEAD)"
echo "Kiln $before -> $after"

npm ci --no-audit --no-fund
npm run build:web

if systemctl --user cat kiln.service >/dev/null 2>&1; then
  echo "Restarting kiln.service. This page reconnects in a few seconds."
  # --no-block: the restart stops this script too (same service); queue it and return.
  systemctl --user restart --no-block kiln.service
else
  echo "No kiln.service: restart the daemon yourself to run $after."
fi
