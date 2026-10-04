#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ ${EUID:-$(id -u)} -ne 0 ]] || { echo "ROOTLESS_UPDATE_REFUSES_ROOT" >&2; exit 2; }

REPO="https://github.com/kmjtechno/kmj-codebridge.git"
BRANCH="${CODEBRIDGE_UPDATE_BRANCH:-main}"
BASE="${CODEBRIDGE_USER_BASE:-$HOME/.local/share/kmj-codebridge}"
RUNTIME="${CODEBRIDGE_RUNTIME:-$BASE/runtime}"
STATE="${CODEBRIDGE_STATE:-$HOME/.local/state/kmj-codebridge}"
CONFIG="${CODEBRIDGE_CONFIG:-$HOME/.config/kmj-codebridge/agent.json}"
PID_FILE="$STATE/agent.pid"
LOG_FILE="$STATE/agent.log"
CONNECTION="$STATE/connection.json"
LOCK="$STATE/update.lock"
NODE="$BASE/node/bin/node"
NPM="$BASE/node/bin/npm"

[[ -x "$NODE" && -x "$NPM" ]] || { echo "ROOTLESS_UPDATE_NODE_MISSING" >&2; exit 3; }
[[ -d "$RUNTIME/.git" ]] || { echo "ROOTLESS_UPDATE_RUNTIME_NOT_GIT" >&2; exit 3; }
[[ -r "$CONFIG" ]] || { echo "ROOTLESS_UPDATE_CONFIG_NOT_READABLE" >&2; exit 3; }
mkdir -p "$STATE"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "ROOTLESS_UPDATE_ALREADY_RUNNING"
  exit 0
fi
NEW="$BASE/runtime.new-$$"
ROLLBACK="$BASE/runtime.rollback-$$"
cleanup() {
  rm -rf "$NEW"
  rmdir "$LOCK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

origin="$(git -C "$RUNTIME" remote get-url origin)"
[[ "$origin" == "$REPO" ]] || { echo "ROOTLESS_UPDATE_ORIGIN_MISMATCH" >&2; exit 4; }
if [[ -n "$(git -C "$RUNTIME" status --porcelain --untracked-files=no)" ]]; then
  echo "ROOTLESS_UPDATE_DIRTY_RUNTIME" >&2
  exit 4
fi

current="$(git -C "$RUNTIME" rev-parse HEAD)"
remote="$(git ls-remote "$REPO" "refs/heads/$BRANCH" | awk 'NR==1{print $1}')"
[[ "$remote" =~ ^[a-f0-9]{40}$ ]] || { echo "ROOTLESS_UPDATE_REMOTE_INVALID" >&2; exit 5; }
if [[ "$current" == "$remote" ]]; then
  echo "ROOTLESS_UPDATE_CURRENT=$current"
  exit 0
fi

git -C "$RUNTIME" fetch --quiet --no-tags origin "$BRANCH"
[[ "$(git -C "$RUNTIME" rev-parse FETCH_HEAD)" == "$remote" ]] || { echo "ROOTLESS_UPDATE_FETCH_MISMATCH" >&2; exit 5; }
git -C "$RUNTIME" merge-base --is-ancestor "$current" "$remote" || { echo "ROOTLESS_UPDATE_NON_FAST_FORWARD" >&2; exit 6; }

if "$NODE" - "$STATE" <<'NODE'
const fs=require("node:fs"),path=require("node:path");
const dir=path.join(process.argv[2],"jobs");
if(!fs.existsSync(dir)) process.exit(0);
for(const name of fs.readdirSync(dir)){
  if(!name.endsWith(".json")) continue;
  try{
    const j=JSON.parse(fs.readFileSync(path.join(dir,name),"utf8"));
    if(j.state==="running"||j.state==="queued") process.exit(9);
  }catch{}
}
NODE
then
  :
else
  code=$?
  if [[ $code -eq 9 ]]; then
    echo "ROOTLESS_UPDATE_DEFERRED_ACTIVE_JOB"
    exit 0
  fi
  exit "$code"
fi

git clone -q --no-tags "$REPO" "$NEW"
git -C "$NEW" checkout -q "$remote"
PATH="$(dirname "$NODE"):$PATH" "$NPM" --prefix "$NEW" ci --ignore-scripts
PATH="$(dirname "$NODE"):$PATH" "$NPM" --prefix "$NEW" run check
PATH="$(dirname "$NODE"):$PATH" "$NPM" --prefix "$NEW" test
PATH="$(dirname "$NODE"):$PATH" "$NPM" --prefix "$NEW" prune --omit=dev --ignore-scripts

pkg="$("$NODE" -e 'const p=require(process.argv[1]);process.stdout.write(p.name+"@"+p.version)' "$NEW/package.json")"
[[ "$pkg" == @kmjtechno/codebridge@* ]] || { echo "ROOTLESS_UPDATE_PACKAGE_INVALID" >&2; exit 7; }

OLD_PID=""
if [[ -r "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
fi
if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
  args="$(ps -p "$OLD_PID" -o args= 2>/dev/null || true)"
  [[ "$args" == *"$RUNTIME/src/cli.js agent $CONFIG"* ]] || { echo "ROOTLESS_UPDATE_PID_MISMATCH" >&2; exit 8; }
  kill "$OLD_PID"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$OLD_PID" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$OLD_PID" 2>/dev/null && { echo "ROOTLESS_UPDATE_STOP_TIMEOUT" >&2; exit 8; }
fi

mv "$RUNTIME" "$ROLLBACK"
mv "$NEW" "$RUNTIME"
START_EPOCH="$(date +%s)"
nohup "$NODE" "$RUNTIME/src/cli.js" agent "$CONFIG" >>"$LOG_FILE" 2>&1 &
NEW_PID=$!
printf '%s\n' "$NEW_PID" >"$PID_FILE"

connected=0
for _ in $(seq 1 25); do
  if [[ -f "$CONNECTION" ]] && [[ "$(stat -c %Y "$CONNECTION")" -ge "$START_EPOCH" ]]; then
    connected=1
    break
  fi
  kill -0 "$NEW_PID" 2>/dev/null || break
  sleep 1
done

if (( connected == 0 )); then
  kill "$NEW_PID" >/dev/null 2>&1 || true
  wait "$NEW_PID" 2>/dev/null || true
  rm -rf "$RUNTIME"
  mv "$ROLLBACK" "$RUNTIME"
  nohup "$NODE" "$RUNTIME/src/cli.js" agent "$CONFIG" >>"$LOG_FILE" 2>&1 &
  printf '%s\n' "$!" >"$PID_FILE"
  echo "ROOTLESS_UPDATE_ROLLED_BACK" >&2
  exit 9
fi

rm -rf "$ROLLBACK"
echo "ROOTLESS_UPDATE_FROM=$current"
echo "ROOTLESS_UPDATE_APPLIED=$remote"
