#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'Run as root/sudo.' >&2; exit 1; }

PROJECT_ID="${CODEBRIDGE_PROJECT_ID:-kmj-main-platform}"
INSTANCE="${CODEBRIDGE_INSTANCE:-kmj-main-platform}"
SOURCE_ROOT="${CODEBRIDGE_SOURCE_ROOT:-}"
PROJECT_ROOT="${CODEBRIDGE_PROJECT_ROOT:-/srv/kmj-codebridge-projects/kmj-main-platform}"
RUNTIME="${CODEBRIDGE_RUNTIME:-/opt/kmj-codebridge-agent}"
ENROLLMENT_BASE="${CODEBRIDGE_ENROLLMENT_BASE:-https://kmjtechno.com}"
STATE_DIR="${CODEBRIDGE_STATE_DIR:-/var/lib/kmj-codebridge-$INSTANCE}"
CONFIG_DIR="${CODEBRIDGE_CONFIG_DIR:-/etc/kmj-codebridge/agents}"
CONFIG="$CONFIG_DIR/$INSTANCE.json"
SERVICE="kmj-codebridge-$INSTANCE.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE"
SUPERVISOR_SOCKET="/run/kmj-codebridge/supervisor.sock"
ENROLLMENT_RESULT="/run/kmj-codebridge-$INSTANCE-enrollment-$$.json"
NODE="${CODEBRIDGE_NODE:-}"

cleanup() { rm -f "$ENROLLMENT_RESULT"; }
trap cleanup EXIT

is_main_platform_repo() {
  local root="$1" origin
  [[ -n "$root" && -d "$root/.git" && -f "$root/apps/platform/composer.json" ]] || return 1
  grep -Fq '"name": "kmjtechno/kmj-main-platform"' "$root/apps/platform/composer.json" || return 1
  origin="$(git -C "$root" remote get-url origin 2>/dev/null || true)"
  [[ "$origin" == "git@github.com:kmjtechno/kmj-main-platform.git" || "$origin" == "https://github.com/kmjtechno/kmj-main-platform.git" || "$origin" == "ssh://git@github.com/kmjtechno/kmj-main-platform.git" ]]
}

if [[ -n "$SOURCE_ROOT" ]]; then
  SOURCE_ROOT="$(readlink -f "$SOURCE_ROOT")"
  is_main_platform_repo "$SOURCE_ROOT" || {
    echo "Configured CODEBRIDGE_SOURCE_ROOT is not the Main Platform Git checkout: $SOURCE_ROOT" >&2
    exit 2
  }
else
  for candidate in     /home/kmjstage/repos/kmj-main-platform     /home/kmjprod/repos/kmj-main-platform     /srv/kmj-main-platform     /opt/kmj-main-platform
  do
    resolved="$(readlink -f "$candidate" 2>/dev/null || true)"
    if is_main_platform_repo "$resolved"; then
      SOURCE_ROOT="$resolved"
      break
    fi
  done

  if [[ -z "$SOURCE_ROOT" ]]; then
    while IFS= read -r gitdir; do
      candidate="${gitdir%/.git}"
      if is_main_platform_repo "$candidate"; then
        SOURCE_ROOT="$(readlink -f "$candidate")"
        break
      fi
    done < <(find /home /srv /opt -maxdepth 7 -type d -name .git -print 2>/dev/null)
  fi
fi

[[ -d "$RUNTIME" && -f "$RUNTIME/src/cli.js" && -f "$RUNTIME/scripts/enroll-device.js" ]] || {
  echo "CodeBridge runtime not found at $RUNTIME" >&2; exit 2;
}
if [[ -z "$NODE" ]]; then
  if [[ -x /opt/kmj-codebridge-node/bin/node ]]; then NODE=/opt/kmj-codebridge-node/bin/node; else NODE="$(command -v node || true)"; fi
fi
[[ -n "$NODE" && -x "$NODE" ]] || { echo 'Node.js runtime not found.' >&2; exit 2; }

install -d -m 0755 /srv/kmj-codebridge-projects
if [[ -e "$PROJECT_ROOT" ]]; then
  is_main_platform_repo "$PROJECT_ROOT" || { echo "Unsafe existing project root: $PROJECT_ROOT" >&2; exit 2; }
else
  if [[ -n "$SOURCE_ROOT" ]]; then
    echo "Using Main Platform Git checkout: $SOURCE_ROOT"
    git clone --quiet --no-hardlinks "$SOURCE_ROOT" "$PROJECT_ROOT"
  else
    echo 'No reusable Main Platform Git checkout found; trying existing GitHub deploy identities.'
    cloned=0
    for clone_user in kmjprod kmjstage root; do
      if [[ "$clone_user" != root ]] && ! id "$clone_user" >/dev/null 2>&1; then
        continue
      fi
      tmp="/tmp/kmj-main-platform-clone-$"
      rm -rf "$tmp"
      if [[ "$clone_user" == root ]]; then
        if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'           git clone --quiet git@github.com:kmjtechno/kmj-main-platform.git "$tmp" 2>/dev/null; then
          cloned=1
        fi
      else
        if sudo -u "$clone_user" -H env GIT_TERMINAL_PROMPT=0           GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'           git clone --quiet git@github.com:kmjtechno/kmj-main-platform.git "$tmp" 2>/dev/null; then
          cloned=1
        fi
      fi
      if (( cloned == 1 )); then
        mv "$tmp" "$PROJECT_ROOT"
        SOURCE_ROOT="$PROJECT_ROOT"
        break
      fi
      rm -rf "$tmp"
    done
    if (( cloned == 0 )); then
      echo 'Unable to clone private kmjtechno/kmj-main-platform with existing VPS GitHub identities.' >&2
      echo 'Authorize the existing kmjprod/kmjstage deploy key for this repository, then rerun.' >&2
      exit 2
    fi
  fi
fi

is_main_platform_repo "$PROJECT_ROOT" || { echo 'Cloned project identity verification failed.' >&2; exit 2; }

if [[ -z "${CODEBRIDGE_SERVICE_USER:-}" ]]; then
  if id kmjrunner >/dev/null 2>&1; then SERVICE_USER=kmjrunner;
  elif id kmjprod >/dev/null 2>&1; then SERVICE_USER=kmjprod;
  elif id kmjstage >/dev/null 2>&1; then SERVICE_USER=kmjstage;
  else SERVICE_USER=root; fi
else
  SERVICE_USER="$CODEBRIDGE_SERVICE_USER"
fi
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "Service user not found: $SERVICE_USER" >&2; exit 2; }
chown -R "$SERVICE_USER:$SERVICE_USER" "$PROJECT_ROOT"

install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR" "$CONFIG_DIR"

if [[ ! -f "$CONFIG" ]]; then
  DEVICE="${CODEBRIDGE_DEVICE_ID:-main-platform-$(hostname -s | tr -cd 'A-Za-z0-9_-' | cut -c1-40)}"
  echo 'Starting secure CodeBridge pairing for KMJ Main Platform.'
  "$NODE" "$RUNTIME/scripts/enroll-device.js"     "$ENROLLMENT_BASE" "$DEVICE" "$PROJECT_ID" "$PROJECT_ROOT" "$ENROLLMENT_RESULT"
  [[ -f "$ENROLLMENT_RESULT" ]] || { echo 'Enrollment did not produce a credential.' >&2; exit 3; }

  PROJECT_ROOT="$PROJECT_ROOT" PROJECT_ID="$PROJECT_ID" STATE_DIR="$STATE_DIR" CONFIG="$CONFIG"   ENROLLMENT_RESULT="$ENROLLMENT_RESULT" SUPERVISOR_SOCKET="$SUPERVISOR_SOCKET" "$NODE" --input-type=module <<'NODE'
import fs from 'node:fs';
const result = JSON.parse(fs.readFileSync(process.env.ENROLLMENT_RESULT, 'utf8'));
if (!result.agent || typeof result.agent.token !== 'string' || result.agent.token.length < 32) throw new Error('invalid enrollment result');
if (!Array.isArray(result.projects) || !result.projects.some(p => p.id === process.env.PROJECT_ID)) throw new Error('project not approved');
const perms = Array.isArray(result.permissions) ? result.permissions : [];
const root = fs.realpathSync(process.env.PROJECT_ROOT);
const config = {
  gateway: result.gateway,
  token: result.agent.token,
  id: result.agent.id,
  tenant: result.agent.tenant,
  stateDir: process.env.STATE_DIR,
  supervisorSocket: process.env.SUPERVISOR_SOCKET,
  pollMs: 100,
  projects: [{
    id: process.env.PROJECT_ID,
    root,
    writable: perms.includes('write'),
    gates: {
      fast: {
        command: '/bin/bash',
        args: ['-lc', 'git diff --check && python3 -B scripts/verify_architecture.py && python3 -B scripts/verify_runtime.py && python3 -B scripts/verify_contracts.py && python3 -B scripts/verify_public_surface.py'],
        timeoutMs: 120000
      },
      platform: {
        command: '/bin/bash',
        args: ['-lc', 'cd apps/platform && npm run check && npm run types:check && vendor/bin/pint --parallel --test && vendor/bin/phpstan analyse && php artisan test'],
        timeoutMs: 300000
      },
      full: {
        command: '/bin/bash',
        args: ['-lc', 'git diff --check && python3 -B scripts/verify_architecture.py && python3 -B scripts/verify_runtime.py && python3 -B scripts/verify_contracts.py && python3 -B scripts/verify_public_surface.py && cd apps/platform && npm run check && npm run types:check && vendor/bin/pint --parallel --test && vendor/bin/phpstan analyse && php artisan test && npm run build'],
        timeoutMs: 300000
      }
    }
  }],
  license: { mode: 'free' }
};
const fd = fs.openSync(process.env.CONFIG, 'wx', 0o600);
try { fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n'); fs.fsyncSync(fd); }
finally { fs.closeSync(fd); }
NODE
  chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG"
else
  "$NODE" --input-type=module - "$CONFIG" "$PROJECT_ROOT" "$PROJECT_ID" <<'NODE'
import fs from 'node:fs';
const [file, root, projectId] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(c.projects) || c.projects.length !== 1) throw new Error('unexpected project count');
if (c.projects[0].id !== projectId || fs.realpathSync(c.projects[0].root) !== fs.realpathSync(root)) throw new Error('existing config project mismatch');
NODE
  echo 'Existing Main Platform agent config verified.'
fi

cat >"$SERVICE_FILE" <<EOF_UNIT
[Unit]
Description=KMJ CodeBridge Agent - Main Platform
After=network-online.target kmj-codebridge-supervisor.socket
Wants=network-online.target kmj-codebridge-supervisor.socket

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
ProtectHome=read-only
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
systemctl enable --now "$SERVICE"
systemctl is-active --quiet "$SERVICE"

echo 'KMJ Main Platform CodeBridge project agent is active.'
echo "project_id=$PROJECT_ID"
echo "project_root=$PROJECT_ROOT"
echo "service=$SERVICE"
