#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fail() { echo "KMJ_BLOCKED: $1" >&2; exit 1; }
[[ "$(id -u)" == 0 && "$(hostname)" == KMJ-elite ]] || fail ROOT_AND_HOST_REQUIRED
for x in curl git tar sha256sum install stat npm bash; do command -v "$x" >/dev/null || fail "MISSING_$x"; done
NODE=/opt/kmj-codebridge-node/bin/node
safe() {
  local file="$1" mode
  [[ -x "$file" && -f "$file" && "$(stat -Lc %u "$file")" == 0 ]] || return 1
  mode="$(stat -Lc %a "$file")"; (( (8#$mode & 8#22) == 0 )) || return 1
  [[ "$("$file" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" == 24 ]]
}
for dir in /opt /opt/kmj-codebridge-node /opt/kmj-codebridge-node/bin; do
  if [[ -e "$dir" || -L "$dir" ]]; then
    [[ -d "$dir" && ! -L "$dir" && "$(stat -c %u "$dir")" == 0 ]] || fail UNSAFE_NODE_PARENT
    mode="$(stat -c %a "$dir")"; (( (8#$mode & 8#22) == 0 )) || fail WRITABLE_NODE_PARENT
  fi
done
if [[ -e "$NODE" || -L "$NODE" ]]; then
  [[ ! -L "$NODE" ]] || fail OPT_NODE_SYMLINK_DENIED
  safe "$NODE" || fail OPT_NODE_UNSAFE_DO_NOT_OVERWRITE
elif safe /usr/bin/node; then
  echo "NODE24_EXISTING: /usr/bin/node"
else
  case "$(uname -m)" in
    x86_64) ARCH=x64; SUM=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 ;;
    aarch64) ARCH=arm64; SUM=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2 ;;
    *) fail UNSUPPORTED_ARCH ;;
  esac
  for dir in /opt /opt/kmj-codebridge-node /opt/kmj-codebridge-node/bin; do
    if [[ ! -e "$dir" && ! -L "$dir" ]]; then install -d -m 0755 -o root -g root "$dir"; fi
  done
  TMP="$(mktemp -d /root/kmj-node24-XXXXXXXX)"; trap 'rm -rf -- "$TMP"' EXIT
  VER=24.21.0; PKG=node-v$VER-linux-$ARCH; FILE=$PKG.tar.xz
  curl --proto '=https' --tlsv1.2 -fLsS --retry 3 --max-time 180 "https://nodejs.org/dist/v$VER/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && printf '%s  %s\n' "$SUM" "$FILE" | sha256sum -c -) || fail NODE_CHECKSUM_FAILED
  tar -xJf "$TMP/$FILE" -C "$TMP" --no-same-owner --no-same-permissions "$PKG/bin/node"
  [[ "$("$TMP/$PKG/bin/node" -v)" == v$VER ]] || fail NODE_BINARY_VERSION_MISMATCH
  [[ ! -e "$NODE" && ! -L "$NODE" ]] || fail OPT_NODE_CONFLICT
  install -m 0755 -o root -g root "$TMP/$PKG/bin/node" "$NODE"
  safe "$NODE" || fail INSTALLED_NODE_INVALID
  rm -rf -- "$TMP"; trap - EXIT
fi
export PATH=/opt/kmj-codebridge-node/bin:$PATH
SHA=7d2aad1d64c380f332e6791347d84bac115d5279
WORK="$(mktemp -d /root/kmj-approved-XXXXXXXX)"; trap 'rm -rf -- "$WORK"' EXIT
mkdir -m 0700 "$WORK/source"
git -c init.templateDir= init -q "$WORK/source"
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -C "$WORK/source" -c core.hooksPath=/dev/null fetch -q --depth=1 --no-tags https://github.com/kmjtechno/kmj-codebridge.git "$SHA"
git -C "$WORK/source" -c core.hooksPath=/dev/null checkout -q --detach "$SHA"
[[ "$(git -C "$WORK/source" rev-parse HEAD)" == "$SHA" ]] || fail SOURCE_SHA_MISMATCH
for f in install-main-platform-control.sh stage-supervisor-root-runtime.sh bootstrap-existing-supervisor.sh; do bash -n "$WORK/source/scripts/production/$f"; done
KMJ_APPROVED_CODEBRIDGE_SHA="$SHA" bash "$WORK/source/scripts/production/install-main-platform-control.sh"
systemctl is-active --quiet kmj-codebridge-supervisor.socket || fail SUPERVISOR_SOCKET_INACTIVE
[[ -S /run/kmj-codebridge/supervisor.sock ]] || fail SUPERVISOR_SOCKET_MISSING
echo KMJ_SUPERVISOR_SOCKET_PASS
echo LIVE_MCP_VERIFICATION_STILL_REQUIRED
