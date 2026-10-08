#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $EUID -eq 0 ]] || { echo "Run with sudo/root." >&2; exit 1; }

GATEWAY="${CODEBRIDGE_GATEWAY:-https://kmj-codebridge-gateway.onrender.com}"
ENROLLMENT_BASE="${CODEBRIDGE_ENROLLMENT_BASE:-https://kmjtechno.com}"
PROJECT="${CODEBRIDGE_PROJECT:-}"
PROJECT_ID="${CODEBRIDGE_PROJECT_ID:-project1}"
DEVICE="${CODEBRIDGE_DEVICE_ID:-$(hostname -s | tr -cd 'A-Za-z0-9._-' | cut -c1-48)}"
SERVICE_USER="${CODEBRIDGE_SERVICE_USER:-${SUDO_USER:-}}"
REF="${CODEBRIDGE_REF:-main}"
INSTALL_DIR="${CODEBRIDGE_INSTALL_DIR:-/opt/kmj-codebridge-agent}"
CONFIG_DIR="${CODEBRIDGE_CONFIG_DIR:-/etc/kmj-codebridge}"
STATE_DIR="${CODEBRIDGE_STATE_DIR:-/var/lib/kmj-codebridge}"
NODE_DIR="${CODEBRIDGE_NODE_DIR:-/opt/kmj-codebridge-node}"
NODE_VERSION="${CODEBRIDGE_NODE_VERSION:-24.21.0}"
CONFIG="$CONFIG_DIR/agent.json"
SERVICE="kmj-codebridge-agent.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE"
ROLLBACK_SERVICE="${SERVICE_FILE}.rollback-codebridge"
SUPERVISOR_SERVICE="kmj-codebridge-supervisor.service"
SUPERVISOR_SOCKET_UNIT="kmj-codebridge-supervisor.socket"
SUPERVISOR_SERVICE_FILE="/etc/systemd/system/$SUPERVISOR_SERVICE"
SUPERVISOR_SOCKET_FILE="/etc/systemd/system/$SUPERVISOR_SOCKET_UNIT"
SUPERVISOR_SOCKET_PATH="/run/kmj-codebridge/supervisor.sock"
ROLLBACK_SUPERVISOR_SERVICE="${SUPERVISOR_SERVICE_FILE}.rollback-codebridge"
ROLLBACK_SUPERVISOR_SOCKET="${SUPERVISOR_SOCKET_FILE}.rollback-codebridge"
MAIN_PLATFORM_REFRESH_SERVICE="kmj-codebridge-main-platform-refresh.service"
MAIN_PLATFORM_REFRESH_SERVICE_FILE="/etc/systemd/system/$MAIN_PLATFORM_REFRESH_SERVICE"
ROLLBACK_MAIN_PLATFORM_REFRESH="${MAIN_PLATFORM_REFRESH_SERVICE_FILE}.rollback-codebridge"
SUPERVISOR_SOCKET_WAS_ENABLED=0
ROLLBACK_CODE="${INSTALL_DIR}.rollback"
ROLLBACK_CONFIG="$CONFIG_DIR/agent.json.rollback"
ENROLLMENT_RESULT="/run/kmj-codebridge-enrollment-$.json"
NEW_DIR="${INSTALL_DIR}.new"
AUTO_UPDATE_MODE="${CODEBRIDGE_AUTO_UPDATE_MODE:-development}"
AUTO_UPDATE_SERVICE="kmj-codebridge-auto-update.service"
AUTO_UPDATE_TIMER="kmj-codebridge-auto-update.timer"
AUTO_UPDATE_SERVICE_FILE="/etc/systemd/system/$AUTO_UPDATE_SERVICE"
AUTO_UPDATE_TIMER_FILE="/etc/systemd/system/$AUTO_UPDATE_TIMER"
STABLE_CONFIG_DIR="${CODEBRIDGE_STABLE_CONFIG_DIR:-/etc/kmj-codebridge-update}"
STABLE_UPDATE_CONFIG="$STABLE_CONFIG_DIR/stable-update.json"
STABLE_INSTALL_ROOT="${CODEBRIDGE_STABLE_INSTALL_ROOT:-/opt/kmj-codebridge-stable}"
STABLE_UPDATE_STATE_DIR="${CODEBRIDGE_STABLE_UPDATE_STATE_DIR:-/var/lib/kmj-codebridge-update}"
STABLE_WORK_DIR="${CODEBRIDGE_STABLE_WORK_DIR:-/var/lib/kmj-codebridge-update-work}"
STABLE_MANIFEST_URL="${CODEBRIDGE_STABLE_MANIFEST_URL:-}"
STABLE_SIGNATURE_URL="${CODEBRIDGE_STABLE_SIGNATURE_URL:-}"
STABLE_TRUSTED_KEYS_FILE="${CODEBRIDGE_STABLE_TRUSTED_KEYS_FILE:-}"
STABLE_UPDATE_SERVICE="kmj-codebridge-stable-update.service"
STABLE_UPDATE_TIMER="kmj-codebridge-stable-update.timer"
STABLE_ROLLBACK_SERVICE="kmj-codebridge-stable-rollback.service"
STABLE_UPDATE_SERVICE_FILE="/etc/systemd/system/$STABLE_UPDATE_SERVICE"
STABLE_UPDATE_TIMER_FILE="/etc/systemd/system/$STABLE_UPDATE_TIMER"
STABLE_ROLLBACK_SERVICE_FILE="/etc/systemd/system/$STABLE_ROLLBACK_SERVICE"
ROLLBACK_STABLE_UPDATE_SERVICE="${STABLE_UPDATE_SERVICE_FILE}.rollback-codebridge"
ROLLBACK_STABLE_UPDATE_TIMER="${STABLE_UPDATE_TIMER_FILE}.rollback-codebridge"
ROLLBACK_STABLE_ROLLBACK_SERVICE="${STABLE_ROLLBACK_SERVICE_FILE}.rollback-codebridge"
ROLLBACK_STABLE_UPDATE_CONFIG="${STABLE_UPDATE_CONFIG}.rollback-codebridge"
STABLE_TIMER_WAS_ENABLED=0

cleanup() {
  rm -f "$ENROLLMENT_RESULT"
  rm -rf "$NEW_DIR"
}
trap cleanup EXIT

while (($#)); do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --enrollment-base) ENROLLMENT_BASE="$2"; shift 2 ;;
    --project-id) PROJECT_ID="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --help|-h)
      cat <<'EOF'
KMJ CodeBridge secure VPS installer

Run from the project directory:
  curl -fsSL https://kmjtechno.com/install | sudo bash

Optional:
  --project /absolute/project
  --gateway https://gateway.example
  --enrollment-base https://account.example
  --project-id project1
  --device device-id
  --service-user user
  --ref main
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

canonical_https_origin() {
  [[ "$1" =~ ^https://[^/?#]+/?$ ]]
}
valid_gateway_origin() {
  canonical_https_origin "$1" ||
    [[ "$1" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?/?$ ]]
}
valid_gateway_origin "$GATEWAY" || { echo "Gateway must be canonical HTTPS or loopback HTTP." >&2; exit 2; }
canonical_https_origin "$ENROLLMENT_BASE" || { echo "Enrollment base must be a canonical HTTPS origin." >&2; exit 2; }
GATEWAY="${GATEWAY%/}"
ENROLLMENT_BASE="${ENROLLMENT_BASE%/}"

case "$AUTO_UPDATE_MODE" in
  development|stable|beta|off) ;;
  *) echo "CODEBRIDGE_AUTO_UPDATE_MODE must be development, stable, beta or off." >&2; exit 2 ;;
esac

safe_absolute_path() {
  [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$1" != *"/../"* ]] && [[ "$1" != */.. ]]
}

for stable_path in "$STABLE_CONFIG_DIR" "$STABLE_INSTALL_ROOT" "$STABLE_UPDATE_STATE_DIR" "$STABLE_WORK_DIR"; do
  safe_absolute_path "$stable_path" || { echo "Stable update paths must be safe absolute paths." >&2; exit 2; }
done

if [[ "$AUTO_UPDATE_MODE" == "stable" || "$AUTO_UPDATE_MODE" == "beta" ]]; then
  [[ "$STABLE_MANIFEST_URL" =~ ^https://[^[:space:]#]+$ ]] || { echo "Stable manifest URL must use HTTPS." >&2; exit 2; }
  [[ "$STABLE_SIGNATURE_URL" =~ ^https://[^[:space:]#]+$ ]] || { echo "Stable signature URL must use HTTPS." >&2; exit 2; }
  [[ -n "$STABLE_TRUSTED_KEYS_FILE" && -f "$STABLE_TRUSTED_KEYS_FILE" && ! -L "$STABLE_TRUSTED_KEYS_FILE" ]] || {
    echo "Stable mode requires a regular CODEBRIDGE_STABLE_TRUSTED_KEYS_FILE." >&2
    exit 2
  }
  [[ "$(stat -c '%u' "$STABLE_TRUSTED_KEYS_FILE")" == "0" ]] || {
    echo "Stable release trust keys must be root-owned." >&2
    exit 2
  }
  trust_mode="$(stat -c '%a' "$STABLE_TRUSTED_KEYS_FILE")"
  (( (8#$trust_mode & 8#022) == 0 )) || {
    echo "Stable release trust keys must not be group/world writable." >&2
    exit 2
  }
fi

if [[ -z "$PROJECT" ]]; then
  candidate="$(pwd -P)"
  if [[ "$candidate" == "/" || ! -d "$candidate" ]]; then
    echo "Run the installer from the project directory or pass --project." >&2
    exit 2
  fi
  if [[ ! -e "$candidate/.git" && ! -e "$candidate/package.json" && ! -e "$candidate/composer.json" && ! -e "$candidate/pyproject.toml" && ! -e "$candidate/Cargo.toml" && ! -e "$candidate/go.mod" ]]; then
    echo "Current directory does not look like a project; pass --project explicitly." >&2
    exit 2
  fi
  PROJECT="$candidate"
fi
PROJECT="$(readlink -f "$PROJECT")"
[[ -d "$PROJECT" && "$PROJECT" != "/" ]] || { echo "Project not found or unsafe." >&2; exit 2; }

[[ -n "$SERVICE_USER" ]] || SERVICE_USER="$(stat -c '%U' "$PROJECT")"
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "Service user does not exist." >&2; exit 2; }
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
if systemctl is-enabled --quiet "$SUPERVISOR_SOCKET_UNIT" 2>/dev/null; then
  SUPERVISOR_SOCKET_WAS_ENABLED=1
fi
if systemctl is-enabled --quiet "$STABLE_UPDATE_TIMER" 2>/dev/null; then
  STABLE_TIMER_WAS_ENABLED=1
fi

install_dependencies() {
  local missing=0
  for c in curl git tar xz sha256sum; do command -v "$c" >/dev/null 2>&1 || missing=1; done
  (( missing == 0 )) && return
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl git tar xz-utils
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl git tar xz
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl git tar xz
  else
    echo "Install curl, git, tar, xz and sha256sum first." >&2
    exit 1
  fi
}
install_dependencies

NODE=""
if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" == "24" ]]; then
  NODE="$(command -v node)"
else
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "Unsupported CPU architecture." >&2; exit 1 ;;
  esac
  BASE="https://nodejs.org/download/release/v$NODE_VERSION"
  FILE="node-v$NODE_VERSION-linux-$ARCH.tar.xz"
  TMP="$(mktemp -d)"
  curl -fsSLo "$TMP/$FILE" "$BASE/$FILE"
  curl -fsSLo "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
  (cd "$TMP" && grep "  $FILE$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$NODE_DIR.new"
  mkdir -p "$NODE_DIR.new"
  tar -xJf "$TMP/$FILE" -C "$NODE_DIR.new" --strip-components=1
  rm -rf "$NODE_DIR"
  mv "$NODE_DIR.new" "$NODE_DIR"
  rm -rf "$TMP"
  NODE="$NODE_DIR/bin/node"
fi
NPM="$(dirname "$NODE")/npm"
[[ -x "$NPM" ]] || NPM="$(command -v npm)"

echo "Installing KMJ CodeBridge runtime..."
git clone -q https://github.com/kmjtechno/kmj-codebridge.git "$NEW_DIR"
git -C "$NEW_DIR" checkout -q "$REF"
(
  cd "$NEW_DIR"
  PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --ignore-scripts
  "$NODE" --check src/agent.js
  "$NODE" --check src/autopilot.js
  "$NODE" --check src/supervisor.js
  "$NODE" --check src/supervisor-client.js
  "$NODE" --check src/enrollment.js
  "$NODE" --check scripts/enroll-device.js
)

install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$CONFIG_DIR" "$STATE_DIR"
install -d -m 0700 -o root -g root "$STABLE_CONFIG_DIR" "$STABLE_UPDATE_STATE_DIR" "$STABLE_WORK_DIR"
install -d -m 0755 -o root -g root "$STABLE_INSTALL_ROOT"

have_config=0
if [[ -f "$CONFIG" ]]; then
  if "$NODE" -e '
    const fs=require("node:fs");
    const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const root=fs.realpathSync(process.argv[2]);
    if(
      typeof c.token!=="string"||
      c.token.length<32||
      !Array.isArray(c.projects)||
      !c.projects.some(p=>p.id===process.argv[3]&&fs.realpathSync(p.root)===root)
    ) process.exit(1);
  ' "$CONFIG" "$PROJECT" "$PROJECT_ID"; then
    have_config=1
    echo "Existing device enrollment found; preserving credential and repairing/updating installation."
  else
    echo "Existing configuration is invalid or bound to a different project; refusing automatic overwrite." >&2
    exit 1
  fi
fi

if (( have_config == 1 )); then
  EXISTING_STATE_DIR="$("$NODE" -e '
    const fs=require("node:fs");
    const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(typeof c.stateDir!=="string"||!c.stateDir.startsWith("/")) process.exit(1);
    process.stdout.write(c.stateDir);
  ' "$CONFIG")"
  safe_absolute_path "$EXISTING_STATE_DIR" || {
    echo "Existing stateDir must be a safe absolute path." >&2
    exit 1
  }
  STATE_DIR="$(readlink -f "$EXISTING_STATE_DIR")"
  [[ -n "$STATE_DIR" ]] || { echo "Existing stateDir cannot be resolved." >&2; exit 1; }
  safe_absolute_path "$STATE_DIR" || {
    echo "Resolved existing stateDir must be a safe absolute path." >&2
    exit 1
  }
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
fi

if (( have_config == 0 )); then
  echo "Starting secure KMJ CodeBridge device pairing..."
  "$NODE" "$NEW_DIR/scripts/enroll-device.js"     "$ENROLLMENT_BASE" "$DEVICE" "$PROJECT_ID" "$PROJECT" "$ENROLLMENT_RESULT"

  [[ -f "$ENROLLMENT_RESULT" ]] || { echo "Enrollment did not return a credential." >&2; exit 1; }

  PROJECT="$PROJECT" PROJECT_ID="$PROJECT_ID" GATEWAY="$GATEWAY" STATE_DIR="$STATE_DIR" SUPERVISOR_SOCKET_PATH="$SUPERVISOR_SOCKET_PATH" ENROLLMENT_RESULT="$ENROLLMENT_RESULT" "$NODE" <<'NODE'
const fs=require("node:fs"),path=require("node:path"),{execFileSync}=require("node:child_process");
const result=JSON.parse(fs.readFileSync(process.env.ENROLLMENT_RESULT,"utf8"));
if(!result.agent||typeof result.agent.token!=="string"||result.agent.token.length<32) throw Error("invalid enrollment result");
if(!result.projects?.some(p=>p.id===process.env.PROJECT_ID)) throw Error("project not approved");
const which=n=>{try{return execFileSync("sh",["-c","command -v -- "+n],{encoding:"utf8"}).trim()}catch{return null}};
const root=fs.realpathSync(process.env.PROJECT),gates={},add=(id,c,args)=>{if(c)gates[id]={command:c,args,timeoutMs:120000}};
const npm=which("npm"),php=which("php"),composer=which("composer"),python=which("python3"),cargo=which("cargo"),go=which("go");
if(fs.existsSync(path.join(root,"package.json"))&&npm){const p=JSON.parse(fs.readFileSync(path.join(root,"package.json")));for(const n of ["test","check","lint","build"])if(p.scripts?.[n])add("npm_"+n,npm,["run",n])}
if(fs.existsSync(path.join(root,"artisan"))&&php)add("laravel_test",php,["artisan","test"]);
if(fs.existsSync(path.join(root,"composer.json"))&&composer)add("composer_test",composer,["test"]);
if(fs.existsSync(path.join(root,"Cargo.toml"))&&cargo)add("cargo_test",cargo,["test","--locked"]);
if(fs.existsSync(path.join(root,"go.mod"))&&go)add("go_test",go,["test","./..."]);
if(python&&(fs.existsSync(path.join(root,"pyproject.toml"))||fs.existsSync(path.join(root,"pytest.ini"))))add("python_test",python,["-m","pytest"]);
const gateway =
  typeof result.gateway === "string" && result.gateway
    ? result.gateway
    : process.env.GATEWAY;
const c={
  gateway,
  token:[REDACTED],
  id:result.agent.id,
  tenant:result.agent.tenant,
  stateDir:process.env.STATE_DIR,
  supervisorSocket:process.env.SUPERVISOR_SOCKET_PATH,
  pollMs:100,
  projects:[{id:process.env.PROJECT_ID,root,writable:result.permissions.includes("write"),gates}],
  license:{mode:"free"}
};
const target="/etc/kmj-codebridge/agent.json";
const fd=fs.openSync(target,"wx",0o600);
try{fs.writeFileSync(fd,JSON.stringify(c,null,2)+"\n");fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
NODE
  chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG"
  rm -f "$ENROLLMENT_RESULT"
fi

if [[ -f "$CONFIG" ]]; then
  cp -a "$CONFIG" "$ROLLBACK_CONFIG"
fi

if (( have_config == 1 )); then
  CONFIG="$CONFIG" GATEWAY="$GATEWAY" "$NODE" <<'NODE'
const fs=require("node:fs");
const file=process.env.CONFIG;
const c=JSON.parse(fs.readFileSync(file,"utf8"));
if(c.gateway!==process.env.GATEWAY){
  const tmp=file+".gateway-"+process.pid;
  const fd=fs.openSync(tmp,"wx",0o600);
  try{fs.writeFileSync(fd,JSON.stringify({...c,gateway:process.env.GATEWAY},null,2)+"\n");fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  fs.renameSync(tmp,file);
}
NODE
fi

CONFIG="$CONFIG" SUPERVISOR_SOCKET_PATH="$SUPERVISOR_SOCKET_PATH" "$NODE" <<'NODE'
const fs=require("node:fs");
const file=process.env.CONFIG,expected=process.env.SUPERVISOR_SOCKET_PATH;
const c=JSON.parse(fs.readFileSync(file,"utf8"));
if(c.supervisorSocket&&c.supervisorSocket!==expected) throw Error("unexpected supervisor socket");
if(c.supervisorSocket!==expected){
  c.supervisorSocket=expected;
  const tmp=file+".supervisor-"+process.pid;
  const fd=fs.openSync(tmp,"wx",0o600);
  try{fs.writeFileSync(fd,JSON.stringify(c,null,2)+"\n");fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  fs.renameSync(tmp,file);
}
NODE
chmod 0600 "$CONFIG"
chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG"

rm -rf "$ROLLBACK_CODE"
if [[ -d "$INSTALL_DIR" ]]; then
  mv "$INSTALL_DIR" "$ROLLBACK_CODE"
fi
mv "$NEW_DIR" "$INSTALL_DIR"

rm -f "$ROLLBACK_SERVICE" "$ROLLBACK_SUPERVISOR_SERVICE" "$ROLLBACK_SUPERVISOR_SOCKET" "$ROLLBACK_MAIN_PLATFORM_REFRESH"   "$ROLLBACK_STABLE_UPDATE_SERVICE" "$ROLLBACK_STABLE_UPDATE_TIMER" "$ROLLBACK_STABLE_ROLLBACK_SERVICE" "$ROLLBACK_STABLE_UPDATE_CONFIG"
if [[ -f "$SERVICE_FILE" ]]; then
  cp -a "$SERVICE_FILE" "$ROLLBACK_SERVICE"
fi
if [[ -f "$SUPERVISOR_SERVICE_FILE" ]]; then
  cp -a "$SUPERVISOR_SERVICE_FILE" "$ROLLBACK_SUPERVISOR_SERVICE"
fi
if [[ -f "$SUPERVISOR_SOCKET_FILE" ]]; then
  cp -a "$SUPERVISOR_SOCKET_FILE" "$ROLLBACK_SUPERVISOR_SOCKET"
fi
if [[ -f "$MAIN_PLATFORM_REFRESH_SERVICE_FILE" ]]; then
  cp -a "$MAIN_PLATFORM_REFRESH_SERVICE_FILE" "$ROLLBACK_MAIN_PLATFORM_REFRESH"
fi
if [[ -f "$STABLE_UPDATE_SERVICE_FILE" ]]; then
  cp -a "$STABLE_UPDATE_SERVICE_FILE" "$ROLLBACK_STABLE_UPDATE_SERVICE"
fi
if [[ -f "$STABLE_UPDATE_TIMER_FILE" ]]; then
  cp -a "$STABLE_UPDATE_TIMER_FILE" "$ROLLBACK_STABLE_UPDATE_TIMER"
fi
if [[ -f "$STABLE_ROLLBACK_SERVICE_FILE" ]]; then
  cp -a "$STABLE_ROLLBACK_SERVICE_FILE" "$ROLLBACK_STABLE_ROLLBACK_SERVICE"
fi
if [[ -f "$STABLE_UPDATE_CONFIG" ]]; then
  cp -a "$STABLE_UPDATE_CONFIG" "$ROLLBACK_STABLE_UPDATE_CONFIG"
fi

write_stable_update_config() {
  if [[ "$AUTO_UPDATE_MODE" != "stable" && "$AUTO_UPDATE_MODE" != "beta" ]]; then
    rm -f "$STABLE_UPDATE_CONFIG"
    return
  fi

  STABLE_CHANNEL="$AUTO_UPDATE_MODE"   STABLE_MANIFEST_URL="$STABLE_MANIFEST_URL"   STABLE_SIGNATURE_URL="$STABLE_SIGNATURE_URL"   STABLE_TRUSTED_KEYS_FILE="$STABLE_TRUSTED_KEYS_FILE"   STABLE_INSTALL_ROOT="$STABLE_INSTALL_ROOT"   STABLE_UPDATE_STATE_DIR="$STABLE_UPDATE_STATE_DIR"   AGENT_STATE_DIR="$STATE_DIR"   STABLE_WORK_DIR="$STABLE_WORK_DIR"   STABLE_UPDATE_CONFIG="$STABLE_UPDATE_CONFIG"   SUPERVISOR_SOCKET_PATH="$SUPERVISOR_SOCKET_PATH"   "$NODE" --input-type=module - "$INSTALL_DIR" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const { stableUpdateConfigSchema } = await import(
  pathToFileURL(path.join(root, "src/stable-updater.js")).href
);
const trustedKeys = JSON.parse(
  fs.readFileSync(process.env.STABLE_TRUSTED_KEYS_FILE, "utf8"),
);
const config = stableUpdateConfigSchema.parse({
  schema: 1,
  channel: process.env.STABLE_CHANNEL,
  manifestUrl: process.env.STABLE_MANIFEST_URL,
  signatureUrl: process.env.STABLE_SIGNATURE_URL,
  trustedKeys,
  installRoot: process.env.STABLE_INSTALL_ROOT,
  stateDir: process.env.STABLE_UPDATE_STATE_DIR,
  agentStateDir: process.env.AGENT_STATE_DIR,
  workDir: process.env.STABLE_WORK_DIR,
  supervisorSocket: process.env.SUPERVISOR_SOCKET_PATH,
  health: { attempts: 10, delayMs: 1000 },
});
const target = process.env.STABLE_UPDATE_CONFIG;
const temp = target + ".tmp-" + process.pid;
const fd = fs.openSync(temp, "wx", 0o600);
try {
  fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n");
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
fs.renameSync(temp, target);
NODE
  chown root:root "$STABLE_UPDATE_CONFIG"
  chmod 0600 "$STABLE_UPDATE_CONFIG"
}

write_stable_update_config

write_service() {
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=KMJ CodeBridge Agent
After=network-online.target $SUPERVISOR_SOCKET_UNIT
Wants=network-online.target $SUPERVISOR_SOCKET_UNIT

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$INSTALL_DIR
ExecStart=/bin/bash -c 'runtime="$INSTALL_DIR"; if { [ "$AUTO_UPDATE_MODE" = "stable" ] || [ "$AUTO_UPDATE_MODE" = "beta" ]; } && [ -L "$STABLE_INSTALL_ROOT/current" ] && [ -f "$STABLE_INSTALL_ROOT/current/src/cli.js" ]; then runtime="$STABLE_INSTALL_ROOT/current"; fi; exec "$NODE" "\$runtime/src/cli.js" agent "$CONFIG"'
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$PROJECT $STATE_DIR
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
}

write_supervisor_units() {
cat >"$SUPERVISOR_SOCKET_FILE" <<EOF
[Unit]
Description=KMJ CodeBridge Supervisor Socket

[Socket]
ListenStream=$SUPERVISOR_SOCKET_PATH
SocketUser=$SERVICE_USER
SocketGroup=$SERVICE_GROUP
SocketMode=0600
DirectoryMode=0711
RemoveOnStop=true
Service=$SUPERVISOR_SERVICE

[Install]
WantedBy=sockets.target
EOF

cat >"$SUPERVISOR_SERVICE_FILE" <<EOF
[Unit]
Description=KMJ CodeBridge Restricted Supervisor
Requires=$SUPERVISOR_SOCKET_UNIT
After=$SUPERVISOR_SOCKET_UNIT

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE $INSTALL_DIR/src/cli.js supervisor
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX
UMask=0077
EOF

cat >"$MAIN_PLATFORM_REFRESH_SERVICE_FILE" <<EOF
[Unit]
Description=KMJ CodeBridge fixed Main Platform agent refresh
After=network-online.target
Wants=network-online.target
# One of the existing enrolled-agent configs must be present; repository is always required.
ConditionPathExists=|/etc/kmj-codebridge-main-platform/agent.json
ConditionPathExists=|/etc/kmj-codebridge/agents/kmj-main-platform.json
ConditionPathExists=/srv/kmj-codebridge-projects/kmj-main-platform/.git

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=$INSTALL_DIR
Environment=CODEBRIDGE_RUNTIME=$INSTALL_DIR
ExecStart=/bin/bash $INSTALL_DIR/scripts/refresh-main-platform-agent.sh
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX
ReadWritePaths=/etc/kmj-codebridge-main-platform /etc/systemd/system /var/lib/kmj-codebridge-kmj-main-platform /srv/kmj-codebridge-projects/kmj-main-platform
UMask=0077
EOF
}

write_stable_update_units() {
cat >"$STABLE_UPDATE_SERVICE_FILE" <<EOF
[Unit]
Description=KMJ CodeBridge signed stable updater
After=network-online.target $SUPERVISOR_SOCKET_UNIT
Wants=network-online.target $SUPERVISOR_SOCKET_UNIT
ConditionPathExists=$STABLE_UPDATE_CONFIG

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/bin/bash -c 'runtime="$INSTALL_DIR"; if [ -L "$STABLE_INSTALL_ROOT/current" ] && [ -f "$STABLE_INSTALL_ROOT/current/src/cli.js" ]; then runtime="$STABLE_INSTALL_ROOT/current"; fi; exec "$NODE" "\$runtime/src/cli.js" stable-update "$STABLE_UPDATE_CONFIG"'
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=$STABLE_INSTALL_ROOT $STABLE_UPDATE_STATE_DIR $STABLE_WORK_DIR
UMask=0077
Nice=10
IOSchedulingClass=idle
EOF

cat >"$STABLE_ROLLBACK_SERVICE_FILE" <<EOF
[Unit]
Description=KMJ CodeBridge bounded stable rollback
After=$SUPERVISOR_SOCKET_UNIT
Wants=$SUPERVISOR_SOCKET_UNIT
ConditionPathExists=$STABLE_UPDATE_CONFIG

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/bin/bash -c 'runtime="$INSTALL_DIR"; if [ -L "$STABLE_INSTALL_ROOT/current" ] && [ -f "$STABLE_INSTALL_ROOT/current/src/cli.js" ]; then runtime="$STABLE_INSTALL_ROOT/current"; fi; exec "$NODE" "\$runtime/src/cli.js" stable-rollback "$STABLE_UPDATE_CONFIG"'
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX
ReadWritePaths=$STABLE_INSTALL_ROOT $STABLE_UPDATE_STATE_DIR
UMask=0077
EOF

cat >"$STABLE_UPDATE_TIMER_FILE" <<EOF
[Unit]
Description=Check for signed KMJ CodeBridge stable updates

[Timer]
OnBootSec=15min
OnUnitActiveSec=1h
RandomizedDelaySec=15min
Persistent=true
Unit=$STABLE_UPDATE_SERVICE

[Install]
WantedBy=timers.target
EOF
}

write_service
write_supervisor_units
write_stable_update_units

rollback() {
  echo "Update/start verification failed; rolling back CodeBridge." >&2
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  systemctl stop "$SUPERVISOR_SERVICE" >/dev/null 2>&1 || true
  systemctl stop "$SUPERVISOR_SOCKET_UNIT" >/dev/null 2>&1 || true
  systemctl stop "$STABLE_UPDATE_TIMER" >/dev/null 2>&1 || true
  systemctl stop "$STABLE_UPDATE_SERVICE" >/dev/null 2>&1 || true
  systemctl stop "$STABLE_ROLLBACK_SERVICE" >/dev/null 2>&1 || true
  if [[ -d "$ROLLBACK_CODE" ]]; then
    rm -rf "$INSTALL_DIR"
    mv "$ROLLBACK_CODE" "$INSTALL_DIR"
  fi
  if [[ -f "$ROLLBACK_CONFIG" ]]; then
    cp -a "$ROLLBACK_CONFIG" "$CONFIG"
    chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG"
    chmod 0600 "$CONFIG"
  fi
  if [[ -f "$ROLLBACK_SERVICE" ]]; then
    cp -a "$ROLLBACK_SERVICE" "$SERVICE_FILE"
  else
    rm -f "$SERVICE_FILE"
  fi
  if [[ -f "$ROLLBACK_SUPERVISOR_SERVICE" ]]; then
    cp -a "$ROLLBACK_SUPERVISOR_SERVICE" "$SUPERVISOR_SERVICE_FILE"
  else
    rm -f "$SUPERVISOR_SERVICE_FILE"
  fi
  if [[ -f "$ROLLBACK_SUPERVISOR_SOCKET" ]]; then
    cp -a "$ROLLBACK_SUPERVISOR_SOCKET" "$SUPERVISOR_SOCKET_FILE"
  else
    rm -f "$SUPERVISOR_SOCKET_FILE"
  fi
  if [[ -f "$ROLLBACK_MAIN_PLATFORM_REFRESH" ]]; then
    cp -a "$ROLLBACK_MAIN_PLATFORM_REFRESH" "$MAIN_PLATFORM_REFRESH_SERVICE_FILE"
  else
    rm -f "$MAIN_PLATFORM_REFRESH_SERVICE_FILE"
  fi
  if [[ -f "$ROLLBACK_STABLE_UPDATE_SERVICE" ]]; then
    cp -a "$ROLLBACK_STABLE_UPDATE_SERVICE" "$STABLE_UPDATE_SERVICE_FILE"
  else
    rm -f "$STABLE_UPDATE_SERVICE_FILE"
  fi
  if [[ -f "$ROLLBACK_STABLE_UPDATE_TIMER" ]]; then
    cp -a "$ROLLBACK_STABLE_UPDATE_TIMER" "$STABLE_UPDATE_TIMER_FILE"
  else
    rm -f "$STABLE_UPDATE_TIMER_FILE"
  fi
  if [[ -f "$ROLLBACK_STABLE_ROLLBACK_SERVICE" ]]; then
    cp -a "$ROLLBACK_STABLE_ROLLBACK_SERVICE" "$STABLE_ROLLBACK_SERVICE_FILE"
  else
    rm -f "$STABLE_ROLLBACK_SERVICE_FILE"
  fi
  if [[ -f "$ROLLBACK_STABLE_UPDATE_CONFIG" ]]; then
    cp -a "$ROLLBACK_STABLE_UPDATE_CONFIG" "$STABLE_UPDATE_CONFIG"
  else
    rm -f "$STABLE_UPDATE_CONFIG"
  fi
  systemctl daemon-reload
  if (( SUPERVISOR_SOCKET_WAS_ENABLED == 1 )); then
    systemctl enable --now "$SUPERVISOR_SOCKET_UNIT" >/dev/null 2>&1 || true
  else
    systemctl disable --now "$SUPERVISOR_SOCKET_UNIT" >/dev/null 2>&1 || true
  fi
  if (( STABLE_TIMER_WAS_ENABLED == 1 )); then
    systemctl enable --now "$STABLE_UPDATE_TIMER" >/dev/null 2>&1 || true
  else
    systemctl disable --now "$STABLE_UPDATE_TIMER" >/dev/null 2>&1 || true
  fi
  systemctl start "$SERVICE" >/dev/null 2>&1 || true
}

systemctl daemon-reload
systemctl enable "$SUPERVISOR_SOCKET_UNIT" >/dev/null
systemctl stop "$SUPERVISOR_SERVICE" >/dev/null 2>&1 || true
if ! systemctl restart "$SUPERVISOR_SOCKET_UNIT"; then
  rollback
  exit 1
fi
systemctl enable "$SERVICE" >/dev/null
START_EPOCH="$(date +%s)"
if ! systemctl restart "$SERVICE"; then
  rollback
  exit 1
fi
sleep 2
if ! systemctl is-active --quiet "$SERVICE"; then
  journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
  rollback
  exit 1
fi

chmod 0600 "$CONFIG"
chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG"

EFFECTIVE_GATEWAY="$("$NODE" -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(c.gateway)' "$CONFIG")"
if ! curl -fsS --max-time 10 "$EFFECTIVE_GATEWAY/healthz" >/dev/null; then
  echo "Agent service is active, but gateway health connectivity check failed." >&2
  rollback
  exit 1
fi

connected=0
for _ in {1..25}; do
  if [[ -f "$STATE_DIR/connection.json" ]] && [[ "$(stat -c %Y "$STATE_DIR/connection.json")" -ge "$START_EPOCH" ]]; then
    connected=1
    break
  fi
  sleep 1
done
if (( connected == 0 )); then
  echo "Agent did not complete an authenticated gateway request; rolling back." >&2
  journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
  rollback
  exit 1
fi

if ! "$NODE" --input-type=module - "$INSTALL_DIR" <<'NODE'
import path from "node:path";
import { pathToFileURL } from "node:url";
const root=process.argv[2];
const mod=await import(pathToFileURL(path.join(root,"src/supervisor-client.js")).href);
const status=await mod.supervisorRequest(
  mod.SUPERVISOR_SOCKET,
  {op:"status",service:"agent"},
  {timeoutMs:5000},
);
if(!status||status.activeState!=="active") process.exit(1);
NODE
then
  echo "Supervisor socket/status verification failed; rolling back." >&2
  journalctl -u "$SUPERVISOR_SERVICE" -n 30 --no-pager >&2 || true
  rollback
  exit 1
fi

rm -rf "$ROLLBACK_CODE"
rm -f "$ROLLBACK_CONFIG" "$ROLLBACK_SERVICE" "$ROLLBACK_SUPERVISOR_SERVICE" "$ROLLBACK_SUPERVISOR_SOCKET"   "$ROLLBACK_STABLE_UPDATE_SERVICE" "$ROLLBACK_STABLE_UPDATE_TIMER" "$ROLLBACK_STABLE_ROLLBACK_SERVICE" "$ROLLBACK_STABLE_UPDATE_CONFIG"

cat >"$AUTO_UPDATE_SERVICE_FILE" <<EOF
[Unit]
Description=KMJ CodeBridge guarded development auto-update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=CODEBRIDGE_AUTO_UPDATE_MODE=$AUTO_UPDATE_MODE
Environment=CODEBRIDGE_INSTALL_DIR=$INSTALL_DIR
Environment=CODEBRIDGE_CONFIG=$CONFIG
ExecStart=/bin/bash $INSTALL_DIR/scripts/auto-update-development.sh
Nice=10
IOSchedulingClass=idle
EOF

cat >"$AUTO_UPDATE_TIMER_FILE" <<'EOF'
[Unit]
Description=Check for KMJ CodeBridge development updates

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
RandomizedDelaySec=10min
Persistent=true
Unit=kmj-codebridge-auto-update.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
case "$AUTO_UPDATE_MODE" in
  development)
    systemctl disable --now "$STABLE_UPDATE_TIMER" >/dev/null 2>&1 || true
    systemctl enable --now "$AUTO_UPDATE_TIMER" >/dev/null
    ;;
  stable|beta)
    systemctl disable --now "$AUTO_UPDATE_TIMER" >/dev/null 2>&1 || true
    systemctl enable --now "$STABLE_UPDATE_TIMER" >/dev/null
    ;;
  off)
    systemctl disable --now "$AUTO_UPDATE_TIMER" >/dev/null 2>&1 || true
    systemctl disable --now "$STABLE_UPDATE_TIMER" >/dev/null 2>&1 || true
    ;;
esac

echo "KMJ CodeBridge is installed, enrolled and running."
echo "Device: $DEVICE"
echo "Project: $PROJECT"
echo "Service: systemctl status $SERVICE --no-pager"
echo "Supervisor: socket-activated at $SUPERVISOR_SOCKET_PATH and idle when unused."
echo "Auto-update mode: $AUTO_UPDATE_MODE"
echo "Development auto-update timer: $AUTO_UPDATE_TIMER"
echo "Signed stable update timer: $STABLE_UPDATE_TIMER"
echo "No inbound VPS port or GitHub Actions runner is required."
