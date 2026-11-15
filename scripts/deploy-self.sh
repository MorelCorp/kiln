#!/usr/bin/env bash
# Update the Kiln clone this daemon runs from to origin/main, rebuild, and restart the service.
# Run from Kiln's Environments page (it is this project's deploy command) or by hand.
# Refuses to run in a checkout with local changes or on a branch other than main: use a dedicated
# deploy clone (see scripts/install-service.sh), not your development checkout.
set -euo pipefail
# The clone this script belongs to, wherever it is called from (the cwd may be another repo).
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."

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

# --include=dev: the service sets NODE_ENV=production, which would make npm ci drop tsx (the
# daemon's runner) and vite (the web build).
install_and_build() {
  npm ci --include=dev --no-audit --no-fund && npm run build:web
}
if ! install_and_build; then
  # Leave the clone matching the code that still runs, so a later restart (or login) works.
  echo "Update failed: rolling back to $before." >&2
  git reset --quiet --hard "$before"
  install_and_build || echo "Rollback install failed too: run 'npm ci --include=dev' here by hand." >&2
  exit 1
fi

if systemctl --user cat kiln.service >/dev/null 2>&1; then
  echo "Restarting kiln.service. This page reconnects in a few seconds."
  # --no-block: the restart stops this script too (same service); queue it and return.
  systemctl --user restart --no-block kiln.service
else
  echo "No kiln.service: restart the daemon yourself to run $after."
fi
