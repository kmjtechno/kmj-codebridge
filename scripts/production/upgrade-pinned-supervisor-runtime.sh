#!/usr/bin/env bash
# Safe one-time KMJ-elite privileged supervisor runtime switch from a reviewed SHA.
# This does not restart the main agent, change its enrollment, or deploy the website.
set -Eeuo pipefail
umask 077
export PATH=/opt/kmj-codebridge-node/bin:/usr/sbin:/usr/bin:/sbin:/bin
fail() { printf 'SUPERVISOR_UPGRADE_BLOCKED=%s\n' "$1" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || fail ROOT_REQUIRED
[[ "$(hostname)" == KMJ-elite ]] || fail WRONG_HOST
SHA="${KMJ_APPROVED_CODEBRIDGE_SHA:-}"
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || fail REVIEWED_SHA_REQUIRED
SOURCE="$(cd -- "$(dirname -- "$0")/../.." && pwd -P)"
[[ "$(git -C "$SOURCE" rev-parse --verify HEAD)" == "$SHA" ]] ||
  fail SOURCE_HEAD_MISMATCH
[[ -z "$(git -C "$SOURCE" status --porcelain --untracked-files=all)" ]] ||
  fail SOURCE_DIRTY
UNIT=kmj-codebridge-supervisor.service
SOCKET=kmj-codebridge-supervisor.socket
SCTL=/usr/bin/systemctl
[[ "$("$SCTL" show "$UNIT" -p LoadState --value)" == loaded ]] ||
  fail SERVICE_NOT_INSTALLED
[[ "$("$SCTL" show "$SOCKET" -p LoadState --value)" == loaded ]] ||
  fail SOCKET_NOT_INSTALLED
"$SCTL" is-active --quiet "$SOCKET" || fail SOCKET_NOT_ACTIVE
"$SCTL" is-active --quiet "$UNIT" && fail SERVICE_BUSY_TRY_WHEN_IDLE

CURRENT="$("$SCTL" show "$UNIT" -p WorkingDirectory --value)"
[[ "$CURRENT" =~ ^/opt/kmj-codebridge-supervisor-stage/[a-f0-9]{40}$ ]] ||
  fail CURRENT_STAGE_UNTRUSTED
[[ -d "$CURRENT" && ! -L "$CURRENT" && -f "$CURRENT/.supervisor-stage" ]] ||
  fail CURRENT_STAGE_MISSING
EXEC="$("$SCTL" show "$UNIT" -p ExecStart --value)"
NODE=
for candidate in /opt/kmj-codebridge-node/bin/node /usr/bin/node; do
  if [[ "$EXEC" == *"argv[]=$candidate $CURRENT/src/cli.js supervisor ;"* ]]; then
    NODE="$candidate"
  fi
done
[[ -n "$NODE" && -x "$NODE" ]] || fail UNEXPECTED_NODE_EXEC
[[ "$(stat -Lc %u "$NODE")" == 0 ]] || fail NODE_NOT_ROOT_OWNED
MODE="$(stat -Lc %a "$NODE")"
(( (8#$MODE & 8#22) == 0 )) || fail NODE_WRITABLE
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[[ "$MAJOR" =~ ^[0-9]+$ ]] && (( MAJOR >= 24 )) ||
  fail NODE_VERSION_TOO_OLD
# Never run untrusted npm through a login-shell or user-controlled PATH.
command -v npm >/dev/null || fail PINNED_NPM_UNAVAILABLE
NPM="$(command -v npm)"
[[ "$NPM" == /opt/kmj-codebridge-node/bin/npm ||
   "$NPM" == /usr/bin/npm ]] || fail NPM_PATH_UNTRUSTED
NPM_TARGET="$(readlink -e "$NPM")"
[[ "$NPM_TARGET" == /opt/kmj-codebridge-node/* ||
   "$NPM_TARGET" == /usr/share/nodejs/npm/* ||
   "$NPM_TARGET" == /usr/bin/npm ]] || fail NPM_TARGET_UNTRUSTED

# Reuse the existing reviewed immutable root staging implementation.
OUTPUT="$(KMJ_APPROVED_CODEBRIDGE_SHA="$SHA" bash "$SOURCE/scripts/production/stage-supervisor-root-runtime.sh")" ||
  fail SOURCE_STAGING_FAILED
STAGE="$(printf '%s\n' "$OUTPUT" | sed -n 's/^SUPERVISOR_STAGE_RUNTIME=//p')"
[[ "$STAGE" == "/opt/kmj-codebridge-supervisor-stage/$SHA" ]] ||
  fail STAGE_SHA_MISMATCH
[[ -f "$STAGE/.supervisor-stage" && ! -L "$STAGE" ]] || fail STAGE_INVALID
"$NODE" --check "$STAGE/src/cli.js" || fail STAGE_SYNTAX_INVALID

DIR="/etc/systemd/system/$UNIT.d"
DROPIN="$DIR/50-kmj-pinned-runtime.conf"
if [[ -e "$DIR" || -L "$DIR" ]]; then
  [[ -d "$DIR" && ! -L "$DIR" &&
    "$(stat -c %u "$DIR")" == 0 ]] || fail DROPIN_DIR_UNSAFE
  MODE="$(stat -c %a "$DIR")"
  (( (8#$MODE & 8#22) == 0 )) || fail DROPIN_DIR_WRITABLE
else
  install -d -m 0755 -o root -g root "$DIR"
fi
[[ ! -e "$DROPIN" && ! -L "$DROPIN" ]] || fail DROPIN_ALREADY_EXISTS

TMP="$(mktemp "$DIR/.kmj-root-upgrade-XXXXXXXX")"
chmod 0644 "$TMP"
cat >"$TMP" <<EOF
[Service]
WorkingDirectory=$STAGE
ExecStart=
ExecStart=$NODE $STAGE/src/cli.js supervisor
EOF

# One short controlled socket handoff prevents a new privileged request
# from racing the unit override; do not interrupt an active supervisor.
installed=0
socket_stopped=0
rollback() {
  status=$?
  [[ -z "$TMP" || ! -f "$TMP" ]] || rm -f -- "$TMP"
  if (( status != 0 )); then
    if (( installed != 0 )); then
      rm -f -- "$DROPIN"
      "$SCTL" daemon-reload || true
    fi
    if (( socket_stopped != 0 )); then
      "$SCTL" start "$SOCKET" || true
    fi
    printf 'SUPERVISOR_UPGRADE_FAILED_ROLLBACK_ATTEMPTED=1\n' >&2
  fi
}
trap rollback EXIT
"$SCTL" stop "$SOCKET" || fail SOCKET_STOP_FAILED
socket_stopped=1
if "$SCTL" is-active --quiet "$UNIT"; then
  fail SERVICE_BECAME_BUSY
fi
mv -n -- "$TMP" "$DROPIN"
[[ -f "$DROPIN" ]] || fail DROPIN_INSTALL_FAILED
installed=1
TMP=
"$SCTL" daemon-reload
[[ "$("$SCTL" show "$UNIT" -p WorkingDirectory --value)" == "$STAGE" ]] ||
  fail EFFECTIVE_RUNTIME_MISMATCH
POST_EXEC="$("$SCTL" show "$UNIT" -p ExecStart --value)"
[[ "$POST_EXEC" == *"argv[]=$NODE $STAGE/src/cli.js supervisor ;"* ]] ||
  fail EFFECTIVE_EXEC_MISMATCH
"$SCTL" start "$SOCKET"
"$SCTL" is-active --quiet "$SOCKET" || fail SOCKET_RESTART_FAILED
[[ -S /run/kmj-codebridge/supervisor.sock ]] || fail SOCKET_FILE_MISSING
socket_stopped=0
printf 'SUPERVISOR_UPGRADE_STAGED_SHA=%s\n' "$SHA"
printf 'SUPERVISOR_UPGRADE_SOCKET_READY=1\n'
printf 'AUTHENTICATED_CODEBRIDGE_MCP_VERIFICATION_REQUIRED=1\n'
