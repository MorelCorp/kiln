#!/usr/bin/env bash
# Install Kiln as a systemd user service running from THIS clone (meant to be a deploy clone,
# separate from the checkout you develop in). No root needed.
#
#   scripts/install-service.sh            write ~/.config/systemd/user/kiln.service and start it
#   scripts/install-service.sh --no-start write it only
#
# The unit captures your current PATH so the daemon finds node, claude, gh, git and your toolchains
# (the bwrap sandbox uses host tools). Re-run it after moving node or the clone.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
root="$(pwd)"
node_bin="$(command -v node)" || { echo "node not on PATH (load nvm first)" >&2; exit 1; }
command -v claude >/dev/null || { echo "claude not on PATH" >&2; exit 1; }
[ -x node_modules/.bin/tsx ] || npm ci --no-audit --no-fund
[ -f web/dist/index.html ] || npm run build:web

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
cat > "$unit_dir/kiln.service" <<UNIT
[Unit]
Description=Kiln software factory (daemon + command center on 127.0.0.1)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$root
Environment=PATH=$PATH
Environment=NODE_ENV=production
ExecStart=$node_bin $root/node_modules/.bin/tsx $root/src/cli.ts daemon
Restart=on-failure
RestartSec=5
# Let a stop abort live runs cleanly (worktrees are kept).
KillSignal=SIGINT
TimeoutStopSec=20

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
echo "Wrote $unit_dir/kiln.service (runs $root)."
if [ "${1:-}" != "--no-start" ]; then
  systemctl --user enable --now kiln.service
  systemctl --user --no-pager status kiln.service | head -5
fi
echo "Logs: journalctl --user -u kiln -f"
