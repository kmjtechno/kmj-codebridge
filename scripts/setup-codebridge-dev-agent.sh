#!/usr/bin/env bash
# One-time root setup: a SEPARATE CodeBridge agent on KMJ-elite that serves the
# public kmj-codebridge repository for development (Node build/test profiles).
# Deny by default: dry-run unless --apply is given; never runs as root; never
# touches the Main Platform agent, its unit, config, state or checkout.
set -euo pipefail
umask 077

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then APPLY=1; shift; fi
[[ $# -eq 0 ]] || { echo 'Usage: setup-codebridge-dev-agent.sh [--apply]' >&2; exit 2; }

PROJECT_ID='kmj-codebridge'
INSTANCE='kmj-codebridge-dev'
REPO_URL='https://github.com/kmjtechno/kmj-codebridge.git'
PROJECT_ROOT='/srv/kmj-codebridge-projects/kmj-codebridge'
# Signed, world-readable runtime kept current by the owner-signed updater (the
# Main Platform agent runs from it as an unprivileged user). The legacy
# /opt/kmj-codebridge-agent tree is root-only and must not be used.
RUNTIME='/opt/kmj-codebridge-stable/current'
NODE='/opt/kmj-codebridge-node/bin/node'
ENROLLMENT_BASE='https://kmjtechno.com'
GATEWAY='https://kmjtechno.com'
SERVICE_USER='kmjdev'
STATE_DIR="/var/lib/$INSTANCE"
CONFIG_DIR="/etc/$INSTANCE"
CONFIG="$CONFIG_DIR/agent.json"
SERVICE="$INSTANCE.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE"
DEVICE='kmj-codebridge-elite'
RESULT="/run/$INSTANCE-enrollment-$$.json"

cleanup() { rm -f "$RESULT"; }
trap cleanup EXIT

echo "MODE=$([[ $APPLY -eq 1 ]] && echo APPLY || echo DRY_RUN)"
echo "project=$PROJECT_ID root=$PROJECT_ROOT service=$SERVICE user=$SERVICE_USER"

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
HOST_SHORT="$(hostname -s)"
[[ "${HOST_SHORT,,}" == "kmj-elite" ]] || { echo "WRONG_HOST: expected kmj-elite, got $HOST_SHORT" >&2; exit 1; }
[[ -x "$NODE" ]] || { echo "NODE_MISSING: $NODE" >&2; exit 2; }
[[ -f "$RUNTIME/src/cli.js" && -f "$RUNTIME/scripts/enroll-device.js" ]] || { echo "RUNTIME_MISSING: $RUNTIME" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo 'GIT_MISSING' >&2; exit 2; }
[[ ! -L "$SERVICE_FILE" && ! -L "$PROJECT_ROOT" && ! -L "$STATE_DIR" && ! -L "$CONFIG_DIR" ]] || { echo 'UNSAFE_SYMLINK' >&2; exit 3; }
if id "$SERVICE_USER" >/dev/null 2>&1; then
  [[ "$(id -u "$SERVICE_USER")" -ne 0 ]] || { echo 'SERVICE_USER_IS_ROOT' >&2; exit 3; }
  echo "service_user=EXISTS"
else
  echo "service_user=WOULD_CREATE (system user, no login shell)"
fi
[[ ! -e "$SERVICE_FILE" && ! -e "$CONFIG" ]] || { echo 'ALREADY_ENROLLED: unit/config exist; nothing changed' >&2; exit 0; }

# The service user must be able to run the live runtime read-only.
echo "runtime_check=$(systemd-run --quiet --wait --collect --pipe -p User=nobody -p NoNewPrivileges=true /bin/sh -c 'test -x "$1" && test -r "$2" && test -r "$3"' sh "$NODE" "$RUNTIME/src/cli.js" "$RUNTIME/scripts/enroll-device.js" >/dev/null 2>&1 && echo OK || echo NOT_READABLE_BY_UNPRIVILEGED_USER)"

if [[ $APPLY -ne 1 ]]; then
  echo 'DRY_RUN_UNCHANGED: re-run with --apply to create the user, checkout, pairing and unit'
  exit 0
fi

id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -m 0755 /srv/kmj-codebridge-projects
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR" "$CONFIG_DIR"

if [[ ! -d "$PROJECT_ROOT/.git" ]]; then
  [[ ! -e "$PROJECT_ROOT" ]] || { echo "UNEXPECTED_TARGET: $PROJECT_ROOT" >&2; exit 3; }
  # Public repository over HTTPS: no deploy key or token is needed or stored.
  sudo -u "$SERVICE_USER" -H env GIT_TERMINAL_PROMPT=0 git clone --quiet "$REPO_URL" "$PROJECT_ROOT"
fi
origin="$(git -c safe.directory="$PROJECT_ROOT" -C "$PROJECT_ROOT" remote get-url origin)"
[[ "$origin" == "$REPO_URL" ]] || { echo "ORIGIN_MISMATCH: $origin" >&2; exit 3; }
chown -R "$SERVICE_USER:$SERVICE_USER" "$PROJECT_ROOT"

echo 'Owner browser approval is required next (pairing code is printed below).'
"$NODE" "$RUNTIME/scripts/enroll-device.js" "$ENROLLMENT_BASE" "$DEVICE" "$PROJECT_ID" "$PROJECT_ROOT" "$RESULT"
[[ -f "$RESULT" ]] || { echo 'ENROLLMENT_NO_CREDENTIAL' >&2; exit 3; }

PROJECT_ROOT="$PROJECT_ROOT" PROJECT_ID="$PROJECT_ID" STATE_DIR="$STATE_DIR" CONFIG="$CONFIG" \
RESULT="$RESULT" GATEWAY="$GATEWAY" "$NODE" --input-type=module <<'NODE'
import fs from 'node:fs';
const r = JSON.parse(fs.readFileSync(process.env.RESULT, 'utf8'));
if (!r.agent || typeof r.agent.token !== 'string' || r.agent.token.length < 32) throw new Error('invalid enrollment result');
if (!Array.isArray(r.projects) || !r.projects.some((p) => p.id === process.env.PROJECT_ID)) throw new Error('project not approved');
if (typeof r.gateway === 'string' && r.gateway) {
  const got = new URL(r.gateway), want = new URL(process.env.GATEWAY);
  if (got.origin !== want.origin || got.username || got.password || !['', '/'].includes(got.pathname) || got.search || got.hash) throw new Error('ENROLLMENT_GATEWAY_MISMATCH');
}
const perms = Array.isArray(r.permissions) ? r.permissions : [];
const config = {
  gateway: process.env.GATEWAY,
  token: r.agent.token,
  id: r.agent.id,
  tenant: r.agent.tenant,
  stateDir: process.env.STATE_DIR,
  pollMs: 100,
  projects: [{
    id: process.env.PROJECT_ID,
    root: fs.realpathSync(process.env.PROJECT_ROOT),
    writable: perms.includes('write'),
    gates: {},
    // Fixed, deny-by-default profiles only (npm ci / test / check / build).
    commandPresets: ['node-standard'],
  }],
  license: { mode: 'free' },
};
const fd = fs.openSync(process.env.CONFIG, 'wx', 0o600);
try { fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE
chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG"

cat >"$SERVICE_FILE" <<EOF_UNIT
[Unit]
Description=KMJ CodeBridge Agent - kmj-codebridge development
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$RUNTIME
ExecStart=$NODE $RUNTIME/src/cli.js agent $CONFIG
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$PROJECT_ROOT $STATE_DIR
UMask=0077

[Install]
WantedBy=multi-user.target
EOF_UNIT

systemctl daemon-reload
if ! systemctl enable --now "$SERVICE" || ! systemctl is-active --quiet "$SERVICE"; then
  echo 'START_FAILED_ROLLBACK' >&2
  systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
  rm -f "$SERVICE_FILE"
  systemctl daemon-reload
  exit 6
fi
echo "CODEBRIDGE_DEV_AGENT_ACTIVE service=$SERVICE project=$PROJECT_ID root=$PROJECT_ROOT"
