#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo "Run with sudo/root." >&2; exit 1; }

PROJECT=""
GATEWAY="https://kmjtechno.com"
DEVICE="$(hostname -s | tr -cd 'A-Za-z0-9._-' | cut -c1-48)"
TENANT="kmj"
PROJECT_ID="project1"
SERVICE_USER="${SUDO_USER:-}"
REF="${CODEBRIDGE_REF:-main}"
while (($#)); do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --tenant) TENANT="$2"; shift 2 ;;
    --project-id) PROJECT_ID="$2"; shift 2 ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" ]] || { echo "--project /absolute/path is required." >&2; exit 2; }
PROJECT="$(readlink -f "$PROJECT")"
[[ -d "$PROJECT" ]] || { echo "Project not found." >&2; exit 2; }
[[ "$GATEWAY" =~ ^https://[^/?#]+/?$ ]] || { echo "Gateway must be an HTTPS origin." >&2; exit 2; }
GATEWAY="${GATEWAY%/}"
[[ -n "$SERVICE_USER" ]] || SERVICE_USER="$(stat -c '%U' "$PROJECT")"
id "$SERVICE_USER" >/dev/null
TOKEN="${CODEBRIDGE_AGENT_TOKEN:-}"
[[ ${#TOKEN} -ge 32 ]] || { echo "CODEBRIDGE_AGENT_TOKEN is required; it is never printed." >&2; exit 2; }

for c in curl git tar xz sha256sum; do
  if ! command -v "$c" >/dev/null; then
    if command -v apt-get >/dev/null; then
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl git tar xz-utils
      break
    fi
    echo "Install curl, git, tar, xz and sha256sum first." >&2
    exit 1
  fi
done

NODE=""
if command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]]; then
  NODE="$(command -v node)"
else
  case "$(uname -m)" in x86_64) ARCH=x64;; aarch64) ARCH=arm64;; *) echo "Unsupported CPU." >&2; exit 1;; esac
  VER="${CODEBRIDGE_NODE_VERSION:-24.21.0}"
  BASE="https://nodejs.org/download/release/v$VER"
  FILE="node-v$VER-linux-$ARCH.tar.xz"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSLo "$TMP/$FILE" "$BASE/$FILE"
  curl -fsSLo "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
  (cd "$TMP" && grep "  $FILE$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/kmj-codebridge-node
  mkdir -p /opt/kmj-codebridge-node
  tar -xJf "$TMP/$FILE" -C /opt/kmj-codebridge-node --strip-components=1
  NODE=/opt/kmj-codebridge-node/bin/node
fi
NPM="$(dirname "$NODE")/npm"
[[ -x "$NPM" ]] || NPM="$(command -v npm)"

rm -rf /opt/kmj-codebridge-agent.new
git clone -q https://github.com/kmjtechno/kmj-codebridge.git /opt/kmj-codebridge-agent.new
git -C /opt/kmj-codebridge-agent.new checkout -q "$REF"
(cd /opt/kmj-codebridge-agent.new && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --ignore-scripts)
rm -rf /opt/kmj-codebridge-agent.old
[[ ! -e /opt/kmj-codebridge-agent ]] || mv /opt/kmj-codebridge-agent /opt/kmj-codebridge-agent.old
mv /opt/kmj-codebridge-agent.new /opt/kmj-codebridge-agent

install -d -m 0700 -o "$SERVICE_USER" -g "$(id -gn "$SERVICE_USER")" /etc/kmj-codebridge /var/lib/kmj-codebridge
PROJECT="$PROJECT" GATEWAY="$GATEWAY" DEVICE="$DEVICE" TENANT="$TENANT" PROJECT_ID="$PROJECT_ID" TOKEN="$TOKEN" "$NODE" <<'NODE'
const fs=require("node:fs"),path=require("node:path"),{execFileSync}=require("node:child_process");
const which=n=>{try{return execFileSync("sh",["-c","command -v -- "+n],{encoding:"utf8"}).trim()}catch{return null}};
const root=process.env.PROJECT,gates={},add=(id,c,args)=>{if(c)gates[id]={command:c,args,timeoutMs:120000}};
const npm=which("npm"),php=which("php"),composer=which("composer"),python=which("python3"),cargo=which("cargo");
if(fs.existsSync(path.join(root,"package.json"))&&npm){const p=JSON.parse(fs.readFileSync(path.join(root,"package.json")));for(const n of ["test","check","lint","build"])if(p.scripts?.[n])add("npm_"+n,npm,["run",n])}
if(fs.existsSync(path.join(root,"artisan"))&&php)add("laravel_test",php,["artisan","test"]);
if(fs.existsSync(path.join(root,"composer.json"))&&composer)add("composer_test",composer,["test"]);
if(fs.existsSync(path.join(root,"Cargo.toml"))&&cargo)add("cargo_test",cargo,["test","--locked"]);
if(python&&(fs.existsSync(path.join(root,"pyproject.toml"))||fs.existsSync(path.join(root,"pytest.ini"))))add("python_test",python,["-m","pytest"]);
const c={gateway:process.env.GATEWAY,token:process.env.TOKEN,id:process.env.DEVICE,tenant:process.env.TENANT,stateDir:"/var/lib/kmj-codebridge",pollMs:100,projects:[{id:process.env.PROJECT_ID,root,writable:true,gates}],license:{mode:"free"}};
fs.writeFileSync("/etc/kmj-codebridge/agent.json",JSON.stringify(c,null,2)+"\n",{mode:0o600});
NODE
chown "$SERVICE_USER:$(id -gn "$SERVICE_USER")" /etc/kmj-codebridge/agent.json

cat >/etc/systemd/system/kmj-codebridge-agent.service <<EOF
[Unit]
Description=KMJ CodeBridge Agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=$SERVICE_USER
Group=$(id -gn "$SERVICE_USER")
WorkingDirectory=/opt/kmj-codebridge-agent
ExecStart=$NODE /opt/kmj-codebridge-agent/src/cli.js agent /etc/kmj-codebridge/agent.json
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$PROJECT /var/lib/kmj-codebridge
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now kmj-codebridge-agent
sleep 1
systemctl is-active --quiet kmj-codebridge-agent
unset TOKEN CODEBRIDGE_AGENT_TOKEN
echo "KMJ CodeBridge installed and running: $DEVICE / $PROJECT_ID"
