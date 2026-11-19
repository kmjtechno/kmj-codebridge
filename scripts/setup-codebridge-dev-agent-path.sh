#!/usr/bin/env bash
# Root, one-time: make the kmj-codebridge DEV agent's jobs use the Node >=24 that
# already ships in /opt/kmj-codebridge-node (agent jobs inherit PATH, and the
# systemd default PATH resolves npm to the older system Node). Adds only a
# systemd drop-in for the dev unit; installs nothing and changes no shared files.
# Dry-run unless --apply.
set -euo pipefail
umask 022

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then APPLY=1; shift; fi
[[ $# -eq 0 ]] || { echo 'Usage: setup-codebridge-dev-agent-path.sh [--apply]' >&2; exit 2; }

NODE_DIR='/opt/kmj-codebridge-node/bin'
SERVICE='kmj-codebridge-dev.service'
DROPIN_DIR="/etc/systemd/system/$SERVICE.d"
DROPIN="$DROPIN_DIR/10-node-path.conf"

echo "MODE=$([[ $APPLY -eq 1 ]] && echo APPLY || echo DRY_RUN)"
[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
HOST_SHORT="$(hostname -s)"
[[ "${HOST_SHORT,,}" == "kmj-elite" ]] || { echo "WRONG_HOST: expected kmj-elite, got $HOST_SHORT" >&2; exit 1; }
[[ -f "/etc/systemd/system/$SERVICE" && ! -L "/etc/systemd/system/$SERVICE" ]] || { echo "DEV_UNIT_MISSING: $SERVICE" >&2; exit 2; }
[[ -x "$NODE_DIR/node" && -x "$NODE_DIR/npm" ]] || { echo "NODE_OR_NPM_MISSING in $NODE_DIR" >&2; exit 2; }
ver="$("$NODE_DIR/node" -p 'process.versions.node' 2>/dev/null || true)"
major="${ver%%.*}"
echo "node_dir=$NODE_DIR node=$ver npm=$("$NODE_DIR/npm" --version 2>/dev/null || echo ?)"
[[ "$major" =~ ^[0-9]+$ && "$major" -ge 24 ]] || { echo "NODE_TOO_OLD: need >=24, found '$ver' (nothing changed)" >&2; exit 3; }

if [[ -f "$DROPIN" ]]; then echo 'ALREADY_PRESENT: drop-in exists; nothing changed'; exit 0; fi
if [[ $APPLY -ne 1 ]]; then
  echo "DRY_RUN_UNCHANGED: --apply would write $DROPIN and restart $SERVICE"
  exit 0
fi

install -d -m 0755 "$DROPIN_DIR"
cat >"$DROPIN" <<EOF_DROPIN
[Service]
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
EOF_DROPIN
systemctl daemon-reload
if ! systemctl restart "$SERVICE" || ! systemctl is-active --quiet "$SERVICE"; then
  echo 'RESTART_FAILED_ROLLBACK' >&2
  rm -f "$DROPIN"; systemctl daemon-reload; systemctl restart "$SERVICE" || true
  exit 6
fi
echo "DEV_AGENT_NODE_PATH_ACTIVE node=$ver service=$SERVICE"
