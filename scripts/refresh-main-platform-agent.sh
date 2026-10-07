#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  echo 'MAIN_PLATFORM_REFRESH_REQUIRES_ROOT' >&2
  exit 2
}

RUNTIME="${CODEBRIDGE_RUNTIME:-/opt/kmj-codebridge-agent}"
PROJECT_ROOT="/srv/kmj-codebridge-projects/kmj-main-platform"
CONFIG_DIR="/etc/kmj-codebridge-main-platform"
CONFIG="$CONFIG_DIR/agent.json"
STATE_DIR="/var/lib/kmj-codebridge-kmj-main-platform"
SETUP="$RUNTIME/scripts/setup-main-platform-agent.sh"

[[ -f "$CONFIG" ]] || {
  echo 'MAIN_PLATFORM_REFRESH_REQUIRES_EXISTING_ENROLLMENT' >&2
  exit 3
}
[[ -d "$PROJECT_ROOT/.git" ]] || {
  echo 'MAIN_PLATFORM_REFRESH_PROJECT_MISSING' >&2
  exit 3
}
[[ -f "$RUNTIME/src/cli.js" && -f "$SETUP" ]] || {
  echo 'MAIN_PLATFORM_REFRESH_RUNTIME_INVALID' >&2
  exit 3
}

exec env \
  CODEBRIDGE_RUNTIME="$RUNTIME" \
  CODEBRIDGE_PROJECT_ROOT="$PROJECT_ROOT" \
  CODEBRIDGE_CONFIG_DIR="$CONFIG_DIR" \
  CODEBRIDGE_STATE_DIR="$STATE_DIR" \
  bash "$SETUP"
