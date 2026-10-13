#!/usr/bin/env bash
# Fixed-purpose root helper installed from reviewed immutable CodeBridge source.
# Does not create units, re-enroll, accept paths or execute unprivileged source.
set -Eeuo pipefail
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "$#" == 0 ]] || fail "SUPERVISOR_START_ARGUMENTS_DENIED"
(( EUID == 0 )) || fail "SUPERVISOR_START_ROOT_REQUIRED"
[[ "$(hostname)" == KMJ-elite ]] || fail "SUPERVISOR_START_HOST_DENIED"

SYSTEMCTL=/usr/bin/systemctl
AGENT=kmj-codebridge-kmj-main-platform.service
SERVICE=kmj-codebridge-supervisor.service
SOCKET=kmj-codebridge-supervisor.socket

[[ "$("$SYSTEMCTL" show "$AGENT" -p LoadState --value)" == loaded ]] ||
  fail "SUPERVISOR_START_AGENT_NOT_LOADED"
[[ "$("$SYSTEMCTL" show "$SERVICE" -p LoadState --value)" == loaded ]] ||
  fail "SUPERVISOR_START_SERVICE_NOT_LOADED"
[[ "$("$SYSTEMCTL" show "$SOCKET" -p LoadState --value)" == loaded ]] ||
  fail "SUPERVISOR_START_SOCKET_NOT_LOADED"

# A root supervisor must NEVER import the writable /srv development checkout.
RUNTIME="$("$SYSTEMCTL" show "$SERVICE" -p WorkingDirectory --value)"
[[ "$RUNTIME" =~ ^/opt/kmj-codebridge-supervisor-stage/[a-f0-9]{40}$ ]] ||
  fail "SUPERVISOR_START_STAGE_NOT_PINNED"
[[ -d "$RUNTIME" && ! -L "$RUNTIME" && -f "$RUNTIME/.supervisor-stage" &&
   ! -L "$RUNTIME/.supervisor-stage" ]] ||
  fail "SUPERVISOR_START_STAGE_MISSING"
EFFECTIVE_EXEC="$("$SYSTEMCTL" show "$SERVICE" -p ExecStart --value)"
[[ "$EFFECTIVE_EXEC" == *"$RUNTIME/src/cli.js supervisor ;"* ]] ||
  fail "SUPERVISOR_START_EXEC_MISMATCH"
[[ "$(stat -c '%u' "$RUNTIME")" == 0 ]] ||
  fail "SUPERVISOR_START_NOT_ROOT_OWNED"
unsafe="$(find "$RUNTIME" -xdev \( -type f -o -type d \) \( ! -user root -o -perm /022 \) -print -quit)"
[[ -z "$unsafe" ]] || fail "SUPERVISOR_START_RUNTIME_WRITABLE"
while IFS= read -r -d '' link; do
  target="$(readlink -f "$link" || true)"
  [[ "$target" == "$RUNTIME/"* ]] ||
    fail "SUPERVISOR_START_EXTERNAL_SYMLINK"
done < <(find "$RUNTIME" -xdev -type l -print0)

"$SYSTEMCTL" enable --now "$SOCKET" >/dev/null ||
  fail "SUPERVISOR_START_SYSTEMD_FAILED"
"$SYSTEMCTL" is-active --quiet "$SOCKET" ||
  fail "SUPERVISOR_START_SOCKET_INACTIVE"
[[ -S /run/kmj-codebridge/supervisor.sock ]] ||
  fail "SUPERVISOR_START_SOCKET_MISSING"
printf '%s\n' "SUPERVISOR_SOCKET_READY=1" "AUTHENTICATED_MCP_NOT_VERIFIED=1"
