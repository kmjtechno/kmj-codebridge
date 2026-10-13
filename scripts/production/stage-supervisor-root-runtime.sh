#!/usr/bin/env bash
# Build the privileged supervisor from owner-reviewed immutable source, never
# from the registered (kmjcode-writable) development agent checkout.
set -Eeuo pipefail
umask 077
die() { printf '%s\n' "$1" >&2; exit 1; }
[[ "$EUID" == 0 && "$(hostname)" == KMJ-elite ]] ||
  die "SUPERVISOR_STAGE_OPERATOR_REQUIRED"

SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SHA="${KMJ_APPROVED_CODEBRIDGE_SHA:-}"
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] ||
  die "SUPERVISOR_STAGE_APPROVED_SHA_REQUIRED"
[[ -d "$SOURCE/src" && -f "$SOURCE/package-lock.json" &&
   -f "$SOURCE/package.json" && -f "$SOURCE/src/cli.js" &&
   -f "$SOURCE/src/supervisor.js" && ! -L "$SOURCE" &&
   ! -L "$SOURCE/src" && ! -L "$SOURCE/package-lock.json" ]] ||
  die "SUPERVISOR_STAGE_SOURCE_MISSING"

# This installer must be executed from a trusted root-owned, pinned archive,
# never the writable /srv/kmj-codebridge-projects/kmj-codebridge checkout.
[[ "$SOURCE" == /tmp/* || "$SOURCE" == /root/* ]] ||
  die "SUPERVISOR_STAGE_SOURCE_LOCATION_DENIED"
# /tmp is sticky and shared, but the *immediate* extraction directory
# must belong to root and not be writable by any other user.
EXTRACTION_PARENT="$(dirname -- "$SOURCE")"
[[ -d "$EXTRACTION_PARENT" && ! -L "$EXTRACTION_PARENT" &&
   "$(stat -c '%u' "$EXTRACTION_PARENT")" == 0 ]] ||
  die "SUPERVISOR_STAGE_SOURCE_PARENT_UNSAFE"
parent_mode="$(stat -c '%a' "$EXTRACTION_PARENT")"
(( (8#$parent_mode & 8#22) == 0 )) ||
  die "SUPERVISOR_STAGE_SOURCE_PARENT_WRITABLE"
[[ "$(stat -c '%u' "$SOURCE")" == 0 ]] ||
  die "SUPERVISOR_STAGE_SOURCE_OWNER_UNSAFE"
source_mode="$(stat -c '%a' "$SOURCE")"
(( (8#$source_mode & 8#22) == 0 )) ||
  die "SUPERVISOR_STAGE_SOURCE_WRITABLE"
for part in src/cli.js src/supervisor.js package.json package-lock.json; do
  [[ -f "$SOURCE/$part" && ! -L "$SOURCE/$part" &&
     "$(stat -c '%u' "$SOURCE/$part")" == 0 ]] ||
    die "SUPERVISOR_STAGE_SOURCE_FILE_UNSAFE"
  mode="$(stat -c '%a' "$SOURCE/$part")"
  (( (8#$mode & 8#22) == 0 )) ||
    die "SUPERVISOR_STAGE_SOURCE_FILE_WRITABLE"
done

BASE="/opt/kmj-codebridge-supervisor-stage"
DEST="$BASE/$SHA"
[[ ! -L "$BASE" ]] || die "SUPERVISOR_STAGE_ROOT_SYMLINK"
install -d -m 0711 -o root -g root "$BASE"
[[ "$(stat -c '%u' "$BASE")" == 0 ]] ||
  die "SUPERVISOR_STAGE_ROOT_UNSAFE"

if [[ -x /opt/kmj-codebridge-node/bin/node ]]; then
  NODE=/opt/kmj-codebridge-node/bin/node
else
  NODE=/usr/bin/node
fi
[[ -x "$NODE" && "$(stat -Lc '%u' "$NODE")" == 0 ]] ||
  die "SUPERVISOR_STAGE_NODE_INVALID"
"$NODE" -e 'if (+process.versions.node.split(".")[0] < 24) process.exit(1)' ||
  die "SUPERVISOR_STAGE_NODE_TOO_OLD"

verify_tree() {
  local root="$1" offender target
  [[ -d "$root" && ! -L "$root" &&
      "$(stat -c '%u' "$root")" == 0 ]] ||
    die "SUPERVISOR_STAGE_RUNTIME_UNSAFE"
  offender="$(find "$root" -xdev \( -type f -o -type d \) \( ! -user root -o -perm /022 \) -print -quit)"
  [[ -z "$offender" ]] || die "SUPERVISOR_STAGE_RUNTIME_WRITABLE"
  while IFS= read -r -d '' link; do
    target="$(readlink -f "$link" || true)"
    [[ "$target" == "$root/"* ]] ||
      die "SUPERVISOR_STAGE_RUNTIME_SYMLINK_ESCAPE"
  done < <(find "$root" -xdev -type l -print0)
}
SOURCE_LOCK_SHA="$(sha256sum "$SOURCE/package-lock.json" | cut -d' ' -f1)"
SOURCE_CLI_SHA="$(sha256sum "$SOURCE/src/cli.js" | cut -d' ' -f1)"
SOURCE_SUP_SHA="$(sha256sum "$SOURCE/src/supervisor.js" | cut -d' ' -f1)"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  verify_tree "$DEST"
  [[ -f "$DEST/.supervisor-stage" && ! -L "$DEST/.supervisor-stage" ]] ||
    die "SUPERVISOR_STAGE_EXISTING_UNVERIFIED"
  expected="$SHA:$SOURCE_LOCK_SHA:$SOURCE_CLI_SHA:$SOURCE_SUP_SHA"
  [[ "$(<"$DEST/.supervisor-stage")" == "$expected" ]] ||
    die "SUPERVISOR_STAGE_EXISTING_MISMATCH"
else
  TMP="$(mktemp -d "$BASE/.stage-XXXXXXXX")"
  cleanup() { [[ -n "${TMP:-}" && -d "$TMP" ]] && rm -rf -- "$TMP"; }
  trap cleanup EXIT
  cp -a -- "$SOURCE/src" "$SOURCE/package.json" "$SOURCE/package-lock.json" "$TMP/"
  [[ ! -L "$TMP/src" ]] || die "SUPERVISOR_STAGE_SOURCE_LINK_UNSAFE"
  npm --prefix "$TMP" ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline ||
    die "SUPERVISOR_STAGE_DEPENDENCY_INSTALL_FAILED"
  [[ -d "$TMP/node_modules" ]] || die "SUPERVISOR_STAGE_DEPENDENCIES_MISSING"
  "$NODE" --check "$TMP/src/cli.js" ||
    die "SUPERVISOR_STAGE_NODE_SYNTAX_FAILED"
  printf '%s\n' "$SHA:$SOURCE_LOCK_SHA:$SOURCE_CLI_SHA:$SOURCE_SUP_SHA" >"$TMP/.supervisor-stage"
  # All future root imports are immutable to every non-root principal.
  find "$TMP" -type d -exec chmod 0555 '{}' +
  find "$TMP" -type f -exec chmod 0444 '{}' +
  verify_tree "$TMP"
  mv -T -- "$TMP" "$DEST"
  TMP=""
  trap - EXIT
fi
printf 'SUPERVISOR_STAGE_READY=1\n'
# This bounded path is consumed ONLY by the same operator-run installer.
printf 'SUPERVISOR_STAGE_RUNTIME=%s\n' "$DEST"
