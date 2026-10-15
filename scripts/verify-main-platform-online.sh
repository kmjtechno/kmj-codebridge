#!/usr/bin/env bash
# Backward-compatible entry point; no service restarts and no OAuth reconnect.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$SCRIPT_DIR/diagnose-main-platform-agent.sh" "$@"
