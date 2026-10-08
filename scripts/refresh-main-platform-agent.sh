#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $(id -u) -eq 0 ]] || {
  echo 'MAIN_PLATFORM_REFRESH_REQUIRES_ROOT' >&2
  exit 2
}

RUNTIME="$(printenv CODEBRIDGE_RUNTIME || true)"
[[ -n "$RUNTIME" ]] || RUNTIME="/opt/kmj-codebridge-agent"
PROJECT_ROOT="/srv/kmj-codebridge-projects/kmj-main-platform"
CONFIG_DIR="/etc/kmj-codebridge-main-platform"
CONFIG="$CONFIG_DIR/agent.json"
LEGACY_CONFIG="/etc/kmj-codebridge/agents/kmj-main-platform.json"
STATE_DIR="/var/lib/kmj-codebridge-kmj-main-platform"
SETUP="$RUNTIME/scripts/setup-main-platform-agent.sh"
SERVICE="kmj-codebridge-kmj-main-platform.service"

[[ -d "$PROJECT_ROOT/.git" ]] || {
  echo 'MAIN_PLATFORM_REFRESH_PROJECT_MISSING' >&2
  exit 3
}
[[ -f "$RUNTIME/src/cli.js" && -f "$SETUP" ]] || {
  echo 'MAIN_PLATFORM_REFRESH_RUNTIME_INVALID' >&2
  exit 3
}
[[ ! -L "$CONFIG" ]] || {
  echo 'MAIN_PLATFORM_REFRESH_UNSAFE_CONFIG' >&2
  exit 3
}

if [[ ! -f "$CONFIG" ]]; then
  [[ -f "$LEGACY_CONFIG" && ! -L "$LEGACY_CONFIG" ]] || {
    echo 'MAIN_PLATFORM_REFRESH_REQUIRES_EXISTING_ENROLLMENT' >&2
    exit 3
  }
  NODE="/opt/kmj-codebridge-node/bin/node"
  [[ -x "$NODE" ]] || NODE="$(command -v node || true)"
  [[ -n "$NODE" && -x "$NODE" ]] || {
    echo 'MAIN_PLATFORM_REFRESH_NODE_MISSING' >&2
    exit 3
  }

  SERVICE_USER="$(systemctl show "$SERVICE" -p User --value 2>/dev/null || true)"
  [[ -n "$SERVICE_USER" ]] || {
    echo 'MAIN_PLATFORM_REFRESH_SERVICE_USER_MISSING' >&2
    exit 3
  }
  id "$SERVICE_USER" >/dev/null 2>&1 || {
    echo 'MAIN_PLATFORM_REFRESH_SERVICE_USER_INVALID' >&2
    exit 3
  }

  # Securely validate existing identity before creating a private config copy.
  # Original credentials remain untouched; no credentials appear in logs.
  LEGACY_CONFIG="$LEGACY_CONFIG" CONFIG="$CONFIG" PROJECT_ROOT="$PROJECT_ROOT" \
  STATE_DIR="$STATE_DIR" SERVICE_UID="$(id -u "$SERVICE_USER")" \
  SERVICE_GID="$(id -g "$SERVICE_USER")" \
  "$NODE" --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const legacy = process.env.LEGACY_CONFIG;
const config = process.env.CONFIG;
const uid = Number(process.env.SERVICE_UID);
const gid = Number(process.env.SERVICE_GID);
const before = fs.lstatSync(legacy);
if (!before.isFile() || before.nlink !== 1 || before.size > 131072 ||
    (before.mode & 0o077) !== 0 ||
    (before.uid !== 0 && before.uid !== uid)) {
  throw new Error('MAIN_PLATFORM_REFRESH_LEGACY_UNSAFE');
}
const originalFd = fs.openSync(
  legacy,
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
);
let bytes;
try {
  const after = fs.fstatSync(originalFd);
  if (!after.isFile() || after.nlink !== 1 || after.size > 131072 ||
      after.ino !== before.ino || after.dev !== before.dev) {
    throw new Error('MAIN_PLATFORM_REFRESH_LEGACY_UNSAFE');
  }
  bytes = fs.readFileSync(originalFd);
} finally {
  fs.closeSync(originalFd);
}
const c = JSON.parse(bytes.toString('utf8'));
const url = new URL(c.gateway);
if (url.protocol !== 'https:' || url.username || url.password ||
    typeof c.token !== 'string' || c.token.length < 32 ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(c.id ?? '') ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(c.tenant ?? '') ||
    c.stateDir !== process.env.STATE_DIR ||
    !Array.isArray(c.projects) || c.projects.length !== 1 ||
    c.projects[0].id !== 'kmj-main-platform' ||
    fs.realpathSync(c.projects[0].root) !== fs.realpathSync(process.env.PROJECT_ROOT)) {
  throw new Error('MAIN_PLATFORM_REFRESH_LEGACY_IDENTITY_INVALID');
}
const dir = path.dirname(config);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const d = fs.lstatSync(dir);
if (!d.isDirectory() || d.isSymbolicLink() ||
    (d.mode & 0o077) !== 0 ||
    (d.uid !== 0 && d.uid !== uid)) {
  throw new Error('MAIN_PLATFORM_REFRESH_CONFIG_DIR_UNSAFE');
}
const fd = fs.openSync(
  config,
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW || 0),
  0o600,
);
try {
  fs.writeFileSync(fd, bytes);
  fs.fchownSync(fd, uid, gid);
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
if (process.platform !== 'win32') {
  const dirfd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try {
    fs.fsyncSync(dirfd);
  } finally {
    fs.closeSync(dirfd);
  }
}
NODE
  chown "$SERVICE_USER:$(id -gn "$SERVICE_USER")" "$CONFIG_DIR"
  chmod 0700 "$CONFIG_DIR"
  echo 'MAIN_PLATFORM_REFRESH_LEGACY_CONFIG_MIGRATED=1'
fi

exec env \
  CODEBRIDGE_RUNTIME="$RUNTIME" \
  CODEBRIDGE_PROJECT_ROOT="$PROJECT_ROOT" \
  CODEBRIDGE_CONFIG_DIR="$CONFIG_DIR" \
  CODEBRIDGE_STATE_DIR="$STATE_DIR" \
  CODEBRIDGE_SERVICE_USER="$(systemctl show "$SERVICE" -p User --value)" \
  bash "$SETUP"
