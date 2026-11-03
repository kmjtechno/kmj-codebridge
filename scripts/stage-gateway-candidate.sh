#!/usr/bin/env bash
# Operator-only, immutable candidate staging: does not alter live gateway.
set -Eeuo pipefail
umask 077
sha="${1:-}"
if [[ $# -ne 1 || ! "$sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo "STAGING=BLOCKED_INVALID_SHA" >&2
  exit 2
fi
if [[ "$(id -u)" -ne 0 || "$(hostname -s | tr '[:upper:]' '[:lower:]')" != kmj-elite ]]; then
  echo "STAGING=BLOCKED_WRONG_HOST_OR_USER" >&2
  exit 2
fi
unit=kmj-codebridge-gateway-stage.service
service_user=kmjcode
base=/opt/kmj-codebridge-candidates
target="$base/$sha"
lock=/run/lock/kmj-codebridge-stage.lock
repo=https://github.com/kmjtechno/kmj-codebridge.git
stage=""
promoted=false
for cmd in systemctl runuser getent id git npm mktemp install stat readlink; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "STAGING=MISSING_COMMAND:$cmd" >&2; exit 2; }
done
if [[ "$(systemctl show "$unit" -p ActiveState --value)" != active ||
      "$(systemctl show "$unit" -p User --value)" != "$service_user" ]]; then
  echo "STAGING=BLOCKED_UNEXPECTED_SERVICE" >&2
  exit 2
fi
pid="$(systemctl show "$unit" -p MainPID --value)"
if [[ ! "$pid" =~ ^[1-9][0-9]*$ || ! -e "/proc/$pid/exe" ]]; then
  echo "STAGING=BLOCKED_NO_GATEWAY_PROCESS" >&2
  exit 2
fi
node="$(readlink -f "/proc/$pid/exe")"
if [[ ! "$node" =~ ^/[A-Za-z0-9_./-]+$ || "$("$node" --version)" != v24.* ]]; then
  echo "STAGING=BLOCKED_NODE24_REQUIRED" >&2
  exit 2
fi
home="$(getent passwd "$service_user" | cut -d: -f6)"
if [[ ! "$home" =~ ^/[A-Za-z0-9_./-]+$ || ! -d "$home" ]]; then
  echo "STAGING=BLOCKED_SERVICE_HOME" >&2
  exit 2
fi
service_path="$(dirname "$node"):/usr/local/bin:/usr/bin:/bin"
run_service() {
  runuser -u "$service_user" -- env -i HOME="$home" PATH="$service_path" \
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 \
    npm_config_audit=false npm_config_fund=false "$@"
}
if [[ ! -d /opt || -L /opt ]]; then
  echo "STAGING=BLOCKED_UNSAFE_OPT" >&2
  exit 2
fi
if [[ ! -e "$base" ]]; then
  install -d -m 0755 -o root -g root "$base"
fi
if [[ ! -d "$base" || -L "$base" || "$(stat -c %u "$base")" != 0 ||
      "$(stat -c %a "$base")" != 755 || -e "$target" || -L "$target" ]]; then
  echo "STAGING=BLOCKED_UNSAFE_OR_EXISTING_CANDIDATE" >&2
  exit 2
fi
if ! mkdir -m 0700 "$lock" 2>/dev/null; then
  echo "STAGING=BLOCKED_LOCK_EXISTS" >&2
  exit 2
fi
cleanup() {
  rc=$?
  if [[ -n "$stage" && "$promoted" == false ]]; then rm -rf -- "$stage"; fi
  rmdir -- "$lock" 2>/dev/null || true
  if [[ $rc -ne 0 ]]; then echo "STAGING=FAIL exit=$rc LIVE_GATEWAY=UNCHANGED" >&2; fi
}
trap cleanup EXIT
if [[ -e "$target" || -L "$target" ]]; then
  echo "STAGING=BLOCKED_CANDIDATE_EXISTS" >&2
  exit 2
fi
stage="$(mktemp -d "$base/.stage-XXXXXXXX")"
chown "$(id -u "$service_user"):$(id -g "$service_user")" "$stage"
chmod 0700 "$stage"
run_service git -C "$stage" init -q
run_service git -C "$stage" -c protocol.version=2 fetch --depth 1 --no-tags "$repo" "$sha"
run_service git -C "$stage" checkout --detach -q FETCH_HEAD
if [[ "$(run_service git -C "$stage" rev-parse HEAD)" != "$sha" ||
      ! -f "$stage/package-lock.json" ]]; then
  echo "STAGING=BLOCKED_SHA_OR_LOCKFILE" >&2
  exit 2
fi
run_service npm --prefix "$stage" ci --ignore-scripts --no-audit --no-fund >/dev/null
for gate in check test scan:secrets; do
  echo "STAGING_GATE=$gate RUNNING"
  if ! (cd "$stage" && run_service npm run "$gate" >/dev/null); then
    echo "STAGING_GATE=$gate FAIL" >&2
    exit 1
  fi
  echo "STAGING_GATE=$gate PASS"
done
# Tests may generate untracked outputs. Never promote those outputs into a
# production gateway runtime. A changed tracked file always blocks. If only
# untracked test files exist, make a NEW clean checkout of the verified commit
# (no git reset/clean; no copies from the tested working tree), reinstall the
# exact lockfile, and attest the clean candidate before publication.
if [[ "$(run_service git -C "$stage" rev-parse HEAD)" != "$sha" ]]; then
  echo "STAGING=BLOCKED_HEAD_DRIFT" >&2
  exit 2
fi
if [[ -n "$(run_service git -C "$stage" status --porcelain --untracked-files=no)" ]]; then
  echo "STAGING=BLOCKED_TRACKED_CHANGES" >&2
  exit 2
fi
if [[ ! -d "$stage/node_modules/zod" ]]; then
  echo "STAGING=BLOCKED_DEPENDENCY_MISSING" >&2
  exit 2
fi
if [[ -n "$(run_service git -C "$stage" ls-files --others --exclude-standard)" ]]; then
  echo "STAGING=UNTRACKED_TEST_OUTPUT_REBUILDING_CLEAN_CANDIDATE"
  original_stage="$stage"
  fresh="$(mktemp -d "$base/.clean-XXXXXXXX")"
  chown "$(id -u "$service_user"):$(id -g "$service_user")" "$fresh"
  chmod 0700 "$fresh"
  # A local clone fetches ONLY committed Git objects. Tests' untracked output
  # and any ignored test/runtime artifacts are not present in the new checkout.
  run_service git -c core.hooksPath=/dev/null clone -q --no-local --no-checkout "$original_stage" "$fresh"
  run_service git -C "$fresh" checkout --detach -q "$sha"
  run_service git -C "$fresh" remote set-url origin "$repo"
  run_service npm --prefix "$fresh" ci --ignore-scripts --no-audit --no-fund >/dev/null
  # Keep failure cleanup scoped to the newly-created candidate, and remove
  # only this script's private disposable test directory.
  stage="$fresh"
  rm -rf -- "$original_stage"
fi
if [[ -n "$(run_service git -C "$stage" status --porcelain)" ]]; then
  echo "STAGING=BLOCKED_CANDIDATE_DIRTY" >&2
  exit 2
fi
if [[ "$(run_service git -C "$stage" rev-parse HEAD)" != "$sha" ||
      ! -d "$stage/node_modules/zod" ]]; then
  echo "STAGING=BLOCKED_CANDIDATE_INCOMPLETE" >&2
  exit 2
fi
echo "STAGING_CLEAN_CANDIDATE=PASS"
mv -T -- "$stage" "$target"
promoted=true
stage=""
echo "STAGING=PASS TARGET_SHA=$sha"
echo "CANDIDATE=$target LIVE_GATEWAY=UNCHANGED"
echo "NEXT_DRY_RUN=sudo $node $target/scripts/gateway-cutover.mjs --target-sha $sha"
echo "APPLY=NOT_REQUESTED"
