#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "AUTO_UPDATE_REQUIRES_ROOT" >&2; exit 2; }

REPO="https://github.com/kmjtechno/kmj-codebridge.git"
BRANCH="${CODEBRIDGE_UPDATE_BRANCH:-main}"
INSTALL_DIR="${CODEBRIDGE_INSTALL_DIR:-/opt/kmj-codebridge-agent}"
CONFIG="${CODEBRIDGE_CONFIG:-/etc/kmj-codebridge/agent.json}"
LOCK_DIR="${CODEBRIDGE_UPDATE_LOCK_DIR:-/run/kmj-codebridge-update.lock}"
MODE="${CODEBRIDGE_AUTO_UPDATE_MODE:-development}"

if [[ "$MODE" != "development" ]]; then
  echo "AUTO_UPDATE_DISABLED_FOR_MODE=$MODE"
  exit 0
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "AUTO_UPDATE_ALREADY_RUNNING"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

[[ -d "$INSTALL_DIR/.git" ]] || { echo "AUTO_UPDATE_RUNTIME_NOT_GIT" >&2; exit 3; }
[[ -r "$CONFIG" ]] || { echo "AUTO_UPDATE_CONFIG_NOT_READABLE" >&2; exit 3; }

origin="$(git -C "$INSTALL_DIR" remote get-url origin)"
[[ "$origin" == "$REPO" ]] || { echo "AUTO_UPDATE_ORIGIN_MISMATCH" >&2; exit 3; }

if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ]]; then
  echo "AUTO_UPDATE_DIRTY_RUNTIME" >&2
  exit 4
fi

current="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
remote="$(git ls-remote "$REPO" "refs/heads/$BRANCH" | awk 'NR==1{print $1}')"
[[ "$remote" =~ ^[a-f0-9]{40}$ ]] || { echo "AUTO_UPDATE_REMOTE_INVALID" >&2; exit 5; }

retry_skipped_main_platform_refresh() {
  local service="kmj-codebridge-main-platform-refresh.service"
  local current_config="/etc/kmj-codebridge-main-platform/agent.json"
  local project="/srv/kmj-codebridge-projects/kmj-main-platform"
  [[ -f "$current_config" && ! -L "$current_config" && -d "$project/.git" ]] || return 0

  # Only retry a fixed unit that was previously skipped before any process ran.
  # A successful, failed or running prior execution must not be replayed.
  local condition last_run
  condition="$(systemctl show "$service" -p ConditionResult --value 2>/dev/null || true)"
  last_run="$(systemctl show "$service" -p ExecMainStartTimestamp --value 2>/dev/null || true)"
  [[ "$condition" == "no" && -z "$last_run" ]] || return 0

  local node
  node="/opt/kmj-codebridge-node/bin/node"
  [[ -x "$node" ]] || node="$(command -v node || true)"
  [[ -n "$node" && -x "$node" ]] || {
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_NODE_UNAVAILABLE" >&2
    return 0
  }

  # Never restart another enrolled agent while its private journal has work.
  if ! CODEBRIDGE_MAIN_CONFIG="$current_config" CODEBRIDGE_MAIN_PROJECT="$project" "$node" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
const configPath = process.env.CODEBRIDGE_MAIN_CONFIG;
const meta = fs.lstatSync(configPath);
if (!meta.isFile() || meta.nlink !== 1 || meta.size > 131072) process.exit(1);
const c = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!Array.isArray(c.projects) || c.projects.length !== 1 ||
    c.projects[0].id !== "kmj-main-platform" ||
    fs.realpathSync(c.projects[0].root) !== fs.realpathSync(process.env.CODEBRIDGE_MAIN_PROJECT) ||
    c.stateDir !== "/var/lib/kmj-codebridge-kmj-main-platform") process.exit(1);
const journal = path.join(c.stateDir, "jobs");
if (fs.existsSync(journal)) {
  const info = fs.lstatSync(journal);
  if (!info.isDirectory() || info.isSymbolicLink()) process.exit(1);
  for (const name of fs.readdirSync(journal)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(journal, name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || st.size > 131072) process.exit(1);
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    if (job.state === "running" || job.state === "queued") process.exit(1);
  }
}
NODE
  then
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_DEFERRED" >&2
    return 0
  fi
  if systemctl start --no-block "$service"; then
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_RECOVERY_SCHEDULED=1"
  else
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_RECOVERY_FAILED=1" >&2
  fi
}

if [[ "$current" == "$remote" ]]; then
  retry_skipped_main_platform_refresh
  echo "AUTO_UPDATE_CURRENT=$current"
  exit 0
fi

git -C "$INSTALL_DIR" fetch --quiet --no-tags origin "$BRANCH"
fetched="$(git -C "$INSTALL_DIR" rev-parse FETCH_HEAD)"
[[ "$fetched" == "$remote" ]] || { echo "AUTO_UPDATE_FETCH_MISMATCH" >&2; exit 5; }

if ! git -C "$INSTALL_DIR" merge-base --is-ancestor "$current" "$remote"; then
  echo "AUTO_UPDATE_NON_FAST_FORWARD" >&2
  exit 6
fi

NODE="$(command -v node)"
if [[ -x "$INSTALL_DIR/../kmj-codebridge-node/bin/node" ]]; then
  NODE="$INSTALL_DIR/../kmj-codebridge-node/bin/node"
elif [[ -x /opt/kmj-codebridge-node/bin/node ]]; then
  NODE=/opt/kmj-codebridge-node/bin/node
fi
[[ -x "$NODE" ]] || { echo "AUTO_UPDATE_NODE_MISSING" >&2; exit 7; }

mapfile -d '' cfg < <("$NODE" - "$CONFIG" <<'NODE'
const fs=require("node:fs");
const c=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const p=c.projects?.[0];
if(!c.id||!p?.id||!p?.root||!c.stateDir||!c.gateway) process.exit(2);
for(const value of [c.id,p.id,p.root,c.stateDir,c.gateway]) process.stdout.write(String(value)+"\0");
NODE
)
[[ ${#cfg[@]} -eq 5 ]] || { echo "AUTO_UPDATE_CONFIG_INVALID" >&2; exit 7; }
DEVICE="${cfg[0]}"
PROJECT_ID="${cfg[1]}"
PROJECT_ROOT="${cfg[2]}"
STATE_DIR="${cfg[3]}"
GATEWAY="${cfg[4]}"
SERVICE_USER="$(stat -c '%U' "$PROJECT_ROOT")"

if "$NODE" - "$STATE_DIR" <<'NODE'
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
    echo "AUTO_UPDATE_DEFERRED_ACTIVE_JOB"
    exit 0
  fi
  echo "AUTO_UPDATE_JOB_STATE_INVALID" >&2
  exit "$code"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

git clone -q --no-tags "$REPO" "$TMP/codebridge"
git -C "$TMP/codebridge" checkout -q "$remote"

pkg="$("$NODE" -e 'const p=require(process.argv[1]);process.stdout.write(p.name+"@"+p.version)' "$TMP/codebridge/package.json")"
[[ "$pkg" == @kmjtechno/codebridge@* ]] || { echo "AUTO_UPDATE_PACKAGE_INVALID" >&2; exit 8; }

echo "AUTO_UPDATE_FROM=$current"
echo "AUTO_UPDATE_TO=$remote"

CODEBRIDGE_GATEWAY="$GATEWAY" CODEBRIDGE_REF="$remote" CODEBRIDGE_AUTO_UPDATE_MODE=development bash "$TMP/codebridge/scripts/install-vps.sh"   --project "$PROJECT_ROOT"   --project-id "$PROJECT_ID"   --device "$DEVICE"   --service-user "$SERVICE_USER"   --ref "$remote"

MAIN_PLATFORM_REFRESH_SERVICE="kmj-codebridge-main-platform-refresh.service"
if [[ -f /etc/kmj-codebridge-main-platform/agent.json && -d /srv/kmj-codebridge-projects/kmj-main-platform/.git ]]; then
  if systemctl start --no-block "$MAIN_PLATFORM_REFRESH_SERVICE"; then
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_SCHEDULED=1"
  else
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_SCHEDULE_FAILED=1" >&2
  fi
fi

echo "AUTO_UPDATE_APPLIED=$remote"
