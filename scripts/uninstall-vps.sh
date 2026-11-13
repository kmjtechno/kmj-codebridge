#!/usr/bin/env bash
# KMJ CodeBridge Linux uninstall. DRY-RUN by default: prints what would change.
#   sudo scripts/uninstall-vps.sh            # plan only
#   sudo scripts/uninstall-vps.sh --apply    # stop+disable units, remove code and unit files
#   ... --apply --purge-data                 # ALSO delete config (device credential) and state/audit/jobs
# Customer data (config, state, audit, jobs) is preserved unless --purge-data is given.
# Never touches Main Platform, other services, Node of the system, or paths outside the
# installer's own directories. Paths are validated before any removal.
set -euo pipefail
umask 077

APPLY=0
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --purge-data) PURGE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

INSTALL_DIR="${CODEBRIDGE_INSTALL_DIR:-/opt/kmj-codebridge-agent}"
CONFIG_DIR="${CODEBRIDGE_CONFIG_DIR:-/etc/kmj-codebridge}"
STATE_DIR="${CODEBRIDGE_STATE_DIR:-/var/lib/kmj-codebridge}"
NODE_DIR="${CODEBRIDGE_NODE_DIR:-/opt/kmj-codebridge-node}"
UNIT_DIR="${CODEBRIDGE_UNIT_DIR:-/etc/systemd/system}"
SYSTEMCTL="${CODEBRIDGE_SYSTEMCTL:-systemctl}"

UNITS=(
  kmj-codebridge-agent.service
  kmj-codebridge-supervisor.service
  kmj-codebridge-supervisor.socket
  kmj-codebridge-main-platform-refresh.service
  kmj-codebridge-auto-update.service
  kmj-codebridge-auto-update.timer
  kmj-codebridge-stable-update.service
  kmj-codebridge-stable-update.timer
)

if [[ $APPLY -eq 1 && $EUID -ne 0 && -z "${CODEBRIDGE_UNINSTALL_TEST:-}" ]]; then
  echo "Run with sudo/root for --apply." >&2
  exit 1
fi

# Refuse dangerous or non-absolute paths, symlinks and short roots.
safe_path() {
  local p="$1"
  [[ "$p" == /* && "$p" != "/" && "$p" != *".."* && ${#p} -ge 8 ]] || return 1
  [[ ! -L "$p" ]] || return 1
  case "$p" in
    /bin*|/boot*|/dev*|/etc|/home|/lib*|/proc*|/root|/run|/sbin*|/sys*|/usr|/var) return 1 ;;
  esac
  return 0
}

for p in "$INSTALL_DIR" "$CONFIG_DIR" "$STATE_DIR" "$NODE_DIR" "$UNIT_DIR"; do
  safe_path "$p" || { echo "UNSAFE_PATH $p" >&2; exit 3; }
done

mode="DRY-RUN"
[[ $APPLY -eq 1 ]] && mode="APPLY"
echo "KMJ_CODEBRIDGE_UNINSTALL=$mode purge_data=$PURGE"

for u in "${UNITS[@]}"; do
  f="$UNIT_DIR/$u"
  if [[ -e "$f" ]]; then
    echo "unit: stop+disable+remove $u"
    if [[ $APPLY -eq 1 ]]; then
      "$SYSTEMCTL" disable --now "$u" >/dev/null 2>&1 || true
      rm -f -- "$f" "$f.rollback-codebridge"
    fi
  fi
done
[[ $APPLY -eq 1 ]] && "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true

for d in "$INSTALL_DIR" "$INSTALL_DIR.rollback" "$INSTALL_DIR.new" "$NODE_DIR"; do
  if [[ -d "$d" ]]; then
    echo "code: remove $d"
    [[ $APPLY -eq 1 ]] && rm -rf -- "$d"
  fi
done

for d in "$CONFIG_DIR" "$STATE_DIR"; do
  if [[ -d "$d" ]]; then
    if [[ $PURGE -eq 1 ]]; then
      echo "data: DELETE $d"
      [[ $APPLY -eq 1 ]] && rm -rf -- "$d"
    else
      echo "data: PRESERVED $d (use --purge-data to delete)"
    fi
  fi
done

echo "KMJ_CODEBRIDGE_UNINSTALL_DONE=$mode"
