#!/usr/bin/env bash
# Bootstrap only the missing CodeBridge supervisor socket and fixed root service
# for an existing authorized Main Platform agent. Never re-enroll or deploy.
set -Eeuo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "${EUID:-$(id -u)}" == 0 ]] || fail "SUPERVISOR_BOOTSTRAP_REQUIRES_ROOT"
[[ "$(hostname)" == "KMJ-elite" ]] || fail "SUPERVISOR_BOOTSTRAP_WRONG_HOST"

AGENT_UNIT="kmj-codebridge-kmj-main-platform.service"
SOCKET_UNIT="kmj-codebridge-supervisor.socket"
SERVICE_UNIT="kmj-codebridge-supervisor.service"
AGENT_CONFIG="/etc/kmj-codebridge-main-platform/agent.json"
SOCKET="/run/kmj-codebridge/supervisor.sock"
[[ "$(systemctl show "$AGENT_UNIT" --property=LoadState --value)" == "loaded" ]] ||
  fail "SUPERVISOR_BOOTSTRAP_AGENT_UNIT_MISSING"

# The existing registered Main Platform agent may run directly from the
# original root-only runtime OR from the root-owned immutable SHA stage
# produced by refresh-main-platform-agent.sh. Never trust an env/CLI supplied
# runtime path; select only the *effective* systemd WorkingDirectory.
RUNTIME="$(systemctl show "$AGENT_UNIT" --property=WorkingDirectory --value)"
if [[ "$RUNTIME" == "/srv/kmj-codebridge-projects/kmj-codebridge" ]]; then
  # This observed, kmjcode-writable development checkout is allowed only
  # as the existing *unprivileged agent*. Never execute it in a root service.
  [[ -d "$RUNTIME" && ! -L "$RUNTIME" ]] ||
    fail "SUPERVISOR_BOOTSTRAP_AGENT_RUNTIME_UNSAFE"
elif [[ "$RUNTIME" == "/opt/kmj-codebridge-agent" ]]; then
  :
elif [[ "$RUNTIME" =~ ^/opt/kmj-codebridge-main-platform-stage/[a-f0-9]{40}$ ]]; then
  STAGE_ROOT="/opt/kmj-codebridge-main-platform-stage"
  [[ -d "$STAGE_ROOT" && ! -L "$STAGE_ROOT" ]] ||
    fail "SUPERVISOR_BOOTSTRAP_STAGE_ROOT_UNSAFE"
  [[ "$(stat -c '%u' "$STAGE_ROOT")" == 0 ]] ||
    fail "SUPERVISOR_BOOTSTRAP_STAGE_ROOT_UNSAFE"
  stage_mode="$(stat -c '%a' "$STAGE_ROOT")"
  (( (8#$stage_mode & 8#22) == 0 )) ||
    fail "SUPERVISOR_BOOTSTRAP_STAGE_ROOT_UNSAFE"
  [[ -f "$RUNTIME/.stage.json" && ! -L "$RUNTIME/.stage.json" ]] ||
    fail "SUPERVISOR_BOOTSTRAP_STAGE_MANIFEST_MISSING"
  # This is a locator consistency check, NOT a signed release assertion.
  python3 - "$RUNTIME/.stage.json" "${RUNTIME##*/}" <<'PY' || fail "SUPERVISOR_BOOTSTRAP_STAGE_SHA_MISMATCH"
import json, sys
from pathlib import Path
manifest = Path(sys.argv[1])
if manifest.stat().st_size > 4096:
    raise SystemExit(1)
data = json.loads(manifest.read_text(encoding="utf-8"))
if not isinstance(data, dict) or data.get("sha") != sys.argv[2]:
    raise SystemExit(1)
PY
else
  fail "SUPERVISOR_BOOTSTRAP_RUNTIME_PATH_UNAPPROVED"
fi
[[ -d "$RUNTIME" && ! -L "$RUNTIME" && -f "$RUNTIME/src/cli.js" ]] ||
  fail "SUPERVISOR_BOOTSTRAP_RUNTIME_NOT_VERIFIED"
[[ -r "$AGENT_CONFIG" ]] ||
  fail "SUPERVISOR_BOOTSTRAP_RUNTIME_OR_CONFIG_MISSING"

# Bind the privileged supervisor to exactly the Node executable and agent
# CLI shown in the *effective* existing unit, never a caller-chosen executable.
EFFECTIVE_EXEC="$(systemctl show "$AGENT_UNIT" --property=ExecStart --value)"
NODE=""
for candidate_node in /opt/kmj-codebridge-node/bin/node /usr/bin/node; do
  if [[ "$EFFECTIVE_EXEC" == *"argv[]=$candidate_node $RUNTIME/src/cli.js agent $AGENT_CONFIG ;"* &&
        -x "$candidate_node" ]]; then
    NODE="$candidate_node"
    break
  fi
done
[[ -n "$NODE" ]] || fail "SUPERVISOR_BOOTSTRAP_AGENT_EXEC_MISMATCH"
# Refuse writable or redirected interpreters, even if their path is approved.
resolved_node="$(readlink -e "$NODE")"
[[ "$resolved_node" == "/usr/bin/node" ||
   "$resolved_node" == "/usr/bin/nodejs" ||
   "$resolved_node" == /opt/kmj-codebridge-node/* ]] ||
  fail "SUPERVISOR_BOOTSTRAP_NODE_TARGET_UNSAFE"
[[ "$(stat -Lc '%u' "$NODE")" == 0 ]] ||
  fail "SUPERVISOR_BOOTSTRAP_NODE_OWNER_UNSAFE"
node_mode="$(stat -Lc '%a' "$NODE")"
(( (8#$node_mode & 8#22) == 0 )) ||
  fail "SUPERVISOR_BOOTSTRAP_NODE_WRITABLE"
[[ -f "$RUNTIME/src/supervisor.js" && -f "$RUNTIME/src/tools.js" ]] ||
  fail "SUPERVISOR_BOOTSTRAP_RUNTIME_UNSUPPORTED"

# Root-supervisor code ALWAYS comes from an independently staged, root-owned
# immutable bundle. The original /srv agent checkout remains owned by kmjcode.
SUPERVISOR_RUNTIME="${KMJ_SUPERVISOR_RUNTIME:-}"
[[ "$SUPERVISOR_RUNTIME" =~ ^/opt/kmj-codebridge-supervisor-stage/[a-f0-9]{40}$ &&
   -d "$SUPERVISOR_RUNTIME" && ! -L "$SUPERVISOR_RUNTIME" &&
   -f "$SUPERVISOR_RUNTIME/.supervisor-stage" ]] ||
  fail "SUPERVISOR_BOOTSTRAP_ROOT_STAGE_MISSING"
[[ "${SUPERVISOR_RUNTIME##*/}" == "${KMJ_APPROVED_CODEBRIDGE_SHA:-}" ]] ||
  fail "SUPERVISOR_BOOTSTRAP_ROOT_STAGE_SHA_MISMATCH"
for checked in "$SUPERVISOR_RUNTIME" "$SUPERVISOR_RUNTIME/src" "$SUPERVISOR_RUNTIME/src/cli.js" \
  "$SUPERVISOR_RUNTIME/src/supervisor.js" "$SUPERVISOR_RUNTIME/src/tools.js" \
  "$SUPERVISOR_RUNTIME/package.json" "$SUPERVISOR_RUNTIME/node_modules" \
  "$SUPERVISOR_RUNTIME/.supervisor-stage"; do
  [[ -e "$checked" && ! -L "$checked" ]] ||
    fail "SUPERVISOR_BOOTSTRAP_RUNTIME_PATH_UNSAFE"
  owner="$(stat -c '%u' "$checked")"
  mode="$(stat -c '%a' "$checked")"
  [[ "$owner" == 0 ]] ||
    fail "SUPERVISOR_BOOTSTRAP_RUNTIME_NOT_ROOT_OWNED"
  # octal group/world write bits, including a sticky directory, are forbidden.
  (( (8#$mode & 8#22) == 0 )) ||
    fail "SUPERVISOR_BOOTSTRAP_RUNTIME_WRITABLE"
done

# Imports under a root supervisor are trusted code, not ordinary project
# files. Verify the complete installed runtime cannot be edited by the
# unprivileged agent, including indirect imported packages.
unsafe="$(find "$SUPERVISOR_RUNTIME" -xdev \( -type f -o -type d \) \( ! -user root -o -perm /022 \) -print -quit)"
[[ -z "$unsafe" ]] || fail "SUPERVISOR_BOOTSTRAP_RUNTIME_TREE_WRITABLE"
while IFS= read -r -d '' link; do
  target="$(readlink -f "$link" || true)"
  [[ "$target" == "$SUPERVISOR_RUNTIME/"* ]] ||
    fail "SUPERVISOR_BOOTSTRAP_RUNTIME_EXTERNAL_SYMLINK"
done < <(find "$SUPERVISOR_RUNTIME" -xdev -type l -print0)

AGENT_USER="$(systemctl show "$AGENT_UNIT" --property=User --value)"
case "$AGENT_USER" in
  kmjrunner|kmjprod|kmjstage) ;;
  kmjcode)
    [[ "$RUNTIME" == "/srv/kmj-codebridge-projects/kmj-codebridge" ]] ||
      fail "SUPERVISOR_BOOTSTRAP_AGENT_USER_RUNTIME_MISMATCH"
    ;;
  *) fail "SUPERVISOR_BOOTSTRAP_AGENT_USER_UNAUTHORIZED" ;;
esac
AGENT_GROUP="$(systemctl show "$AGENT_UNIT" --property=Group --value)"
[[ -n "$AGENT_GROUP" ]] || AGENT_GROUP="$(id -gn "$AGENT_USER")"
[[ -n "$AGENT_GROUP" ]] || fail "SUPERVISOR_BOOTSTRAP_AGENT_GROUP_MISSING"
id "$AGENT_USER" >/dev/null 2>&1 ||
  fail "SUPERVISOR_BOOTSTRAP_AGENT_USER_MISSING"
getent group "$AGENT_GROUP" >/dev/null ||
  fail "SUPERVISOR_BOOTSTRAP_AGENT_GROUP_MISSING"
[[ "$AGENT_GROUP" =~ ^[a-z_][a-z0-9_-]*$ ]] ||
  fail "SUPERVISOR_BOOTSTRAP_AGENT_GROUP_INVALID"

# Effective unit identity must match the fixed pre-existing enrollment.
[[ "$EFFECTIVE_EXEC" == *"argv[]=$NODE $RUNTIME/src/cli.js agent $AGENT_CONFIG ;"* ]] ||
  fail "SUPERVISOR_BOOTSTRAP_AGENT_EXEC_MISMATCH"
# Installer owns the private agent config as the registered service user
# (0600), not necessarily root. Never follow a config symlink.
[[ ! -L "$AGENT_CONFIG" ]] ||
  fail "SUPERVISOR_BOOTSTRAP_CONFIG_SYMLINK_UNSAFE"
config_owner="$(stat -c '%U' "$AGENT_CONFIG")"
config_mode="$(stat -c '%a' "$AGENT_CONFIG")"
[[ "$config_owner" == "$AGENT_USER" || "$config_owner" == root ]] ||
  fail "SUPERVISOR_BOOTSTRAP_CONFIG_OWNER_MISMATCH"
(( (8#$config_mode & 8#77) == 0 )) ||
  fail "SUPERVISOR_BOOTSTRAP_CONFIG_PERMISSIONS_UNSAFE"
python3 - "$AGENT_CONFIG" "$SOCKET" <<'PY' ||
  fail "SUPERVISOR_BOOTSTRAP_AGENT_SOCKET_MISMATCH"
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data.get("supervisorSocket") == sys.argv[2]
assert any(p.get("id") == "kmj-main-platform" for p in data.get("projects", []))
PY

SOCKET_FILE="/etc/systemd/system/$SOCKET_UNIT"
SERVICE_FILE="/etc/systemd/system/$SERVICE_UNIT"
socket_load="$(systemctl show "$SOCKET_UNIT" --property=LoadState --value)"
service_load="$(systemctl show "$SERVICE_UNIT" --property=LoadState --value)"
case "$socket_load" in loaded|not-found) ;; *) fail "SUPERVISOR_BOOTSTRAP_SOCKET_UNIT_INVALID";; esac
case "$service_load" in loaded|not-found) ;; *) fail "SUPERVISOR_BOOTSTRAP_SERVICE_UNIT_INVALID";; esac

if [[ "$socket_load" == "not-found" ]]; then
  [[ ! -e "$SOCKET_FILE" && ! -L "$SOCKET_FILE" ]] ||
    fail "SUPERVISOR_BOOTSTRAP_SOCKET_FILE_CONFLICT"
  tmp="$(mktemp /etc/systemd/system/.codebridge-socket.XXXXXX)"
  cat >"$tmp" <<EOF
[Unit]
Description=KMJ CodeBridge restricted supervisor socket

[Socket]
ListenStream=$SOCKET
SocketUser=$AGENT_USER
SocketGroup=$AGENT_GROUP
SocketMode=0600
DirectoryMode=0711
RemoveOnStop=true
Service=$SERVICE_UNIT

[Install]
WantedBy=sockets.target
EOF
  chmod 0644 "$tmp"
  mv -n "$tmp" "$SOCKET_FILE"
fi

if [[ "$service_load" == "not-found" ]]; then
  [[ ! -e "$SERVICE_FILE" && ! -L "$SERVICE_FILE" ]] ||
    fail "SUPERVISOR_BOOTSTRAP_SERVICE_FILE_CONFLICT"
  tmp="$(mktemp /etc/systemd/system/.codebridge-service.XXXXXX)"
  cat >"$tmp" <<EOF
[Unit]
Description=KMJ CodeBridge restricted, socket-activated supervisor
Requires=$SOCKET_UNIT
After=$SOCKET_UNIT

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$SUPERVISOR_RUNTIME
ExecStart=$NODE $SUPERVISOR_RUNTIME/src/cli.js supervisor
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=tmpfs
BindReadOnlyPaths=/home/kmjprod
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX
UMask=0077
EOF
  chmod 0644 "$tmp"
  mv -n "$tmp" "$SERVICE_FILE"
fi

# A configured drop-in may be intentionally present; never overwrite it.
systemctl daemon-reload
[[ "$(systemctl show "$SOCKET_UNIT" --property=LoadState --value)" == "loaded" ]] ||
  fail "SUPERVISOR_BOOTSTRAP_SOCKET_NOT_LOADED"
[[ "$(systemctl show "$SERVICE_UNIT" --property=LoadState --value)" == "loaded" ]] ||
  fail "SUPERVISOR_BOOTSTRAP_SERVICE_NOT_LOADED"
systemctl enable --now "$SOCKET_UNIT" >/dev/null
systemctl is-active --quiet "$SOCKET_UNIT" ||
  fail "SUPERVISOR_BOOTSTRAP_SOCKET_NOT_ACTIVE"
[[ -S "$SOCKET" ]] || fail "SUPERVISOR_BOOTSTRAP_SOCKET_FILE_MISSING"
printf 'SUPERVISOR_SOCKET_ACTIVE=1\n'
printf 'SUPERVISOR_AGENT_USER=%s\n' "$AGENT_USER"
printf 'SUPERVISOR_SERVICE_SOCKET_ACTIVATED=1\n'
printf 'SUPERVISOR_AGENT_NOT_RESTARTED=1\n'
