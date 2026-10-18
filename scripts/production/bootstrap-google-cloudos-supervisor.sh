#!/usr/bin/env bash
# KMJ CloudOS: guarded owner-executed Supervisor bootstrap. No new paid infra.
# NEVER execute the user-owned agent checkout with root privileges.
set -Eeuo pipefail
umask 077

SOURCE_PIN=fa9340b958ce50000298282d65f3132596c16503
AGENT_PIN=dea0a6e398cd4706ddc61e314174314b9a6f95ee
REPO=https://github.com/kmjtechno/kmj-codebridge.git
HOST=google-vps1
UNIT=kmj-codebridge-cloudos.service
SOCKET_UNIT=kmj-codebridge-supervisor.socket
SERVICE_UNIT=kmj-codebridge-supervisor.service
SOCKET=/run/kmj-codebridge/supervisor.sock
CONFIG=/home/info/.config/kmj-codebridge/agent.json
RUNTIME=/home/info/.local/share/kmj-codebridge/runtime-v0.3.2-20261012
BASE=/opt/kmj-codebridge-cloudos-supervisor
STAGE=''
BACKUP=''
NEWCFG=''
UNITS_INSTALLED=0
CONFIG_CHANGED=0
SUCCESS=0
die() { echo "CLOUDOS_SUPERVISOR_BLOCKED=$1" >&2; exit 2; }

finish() {
  local rc=$?
  trap - EXIT
  if (( SUCCESS == 0 )); then
    if (( CONFIG_CHANGED == 1 )) && [[ -f "$BACKUP" && ! -L "$BACKUP" ]]; then
      install -o info -g info -m 0600 "$BACKUP" "$CONFIG.restore"
      mv -f "$CONFIG.restore" "$CONFIG"
      systemctl restart "$UNIT" >/dev/null 2>&1 || true
      echo "SUPERVISOR_CONFIG_ROLLBACK=ATTEMPTED"
    fi
    if (( UNITS_INSTALLED == 1 )); then
      systemctl disable --now "$SOCKET_UNIT" >/dev/null 2>&1 || true
      systemctl stop "$SERVICE_UNIT" >/dev/null 2>&1 || true
      rm -f -- "/etc/systemd/system/$SOCKET_UNIT" "/etc/systemd/system/$SERVICE_UNIT"
      systemctl daemon-reload >/dev/null 2>&1 || true
      echo "SUPERVISOR_NEW_UNITS_ROLLBACK=ATTEMPTED"
    fi
  fi
  [[ -z "$NEWCFG" ]] || rm -f -- "$NEWCFG"
  if [[ -n "$STAGE" && "$STAGE" == "$BASE"/.stage-* && -d "$STAGE" ]]; then
    rm -rf -- "$STAGE"
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ $# == 0 ]] || die UNEXPECTED_ARGUMENTS
[[ "$(id -u)" == 0 ]] || die ROOT_REQUIRED
[[ "$(hostname -s)" == "$HOST" ]] || die WRONG_HOST
[[ "$(curl -fsS --noproxy '*' --connect-timeout 2 --max-time 4 \
  -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/name)" == \
  instance-20260912-094732 ]] || die WRONG_GCE_INSTANCE
[[ "$(systemctl show -p User --value "$UNIT")" == info ]] || die WRONG_AGENT_USER
[[ "$(systemctl show -p WorkingDirectory --value "$UNIT")" == "$RUNTIME" ]] ||
  die WRONG_AGENT_RUNTIME
[[ "$(systemctl show -p FragmentPath --value "$UNIT")" == \
  "/etc/systemd/system/$UNIT" ]] || die AGENT_UNIT_CHANGED
[[ -f "$CONFIG" && ! -L "$CONFIG" && "$(stat -c %U:%a "$CONFIG")" == info:600 ]] ||
  die CONFIG_UNSAFE
[[ -d "$RUNTIME" && ! -L "$RUNTIME" &&
   "$(git -C "$RUNTIME" rev-parse HEAD)" == "$AGENT_PIN" ]] ||
  die AGENT_SHA_CHANGED
for unit in "$UNIT" kmj-cloudos-api.service kmj-cloudos-worker.service; do
  systemctl is-active --quiet "$unit" || die HOST_SERVICE_INACTIVE
done
[[ -d /home/info/kmj-cloudos && ! -L /home/info/kmj-cloudos ]] ||
  die PROJECT_ROOT_CHANGED
[[ ! -e "$SOCKET" &&
   ! -e "/etc/systemd/system/$SOCKET_UNIT" &&
   ! -e "/etc/systemd/system/$SERVICE_UNIT" ]] ||
  die EXISTING_SUPERVISOR_CONFLICT
[[ ! -L "$BASE" && ! -e "$BASE/$SOURCE_PIN" ]] || die STAGING_CONFLICT
[[ "$(stat -c %u /opt)" == 0 ]] || die ROOT_BASE_UNSAFE

pid=$(systemctl show -p MainPID --value "$UNIT")
[[ "$pid" =~ ^[1-9][0-9]*$ ]] || die AGENT_PID_UNAVAILABLE
node=$(readlink -e "/proc/$pid/exe")
[[ "$node" == /usr/bin/* || "$node" == /usr/local/bin/* ||
   "$node" == /opt/* ]] || die ROOT_MANAGED_NODE_REQUIRED
[[ -x "$node" && "$(stat -Lc %u "$node")" == 0 ]] || die NODE_OWNER_UNSAFE
[[ "$("$node" -p 'process.versions.node.split(".")[0]')" == 24 ]] ||
  die NODE24_REQUIRED
npm=$(command -v npm || true)
[[ -n "$npm" && -x "$npm" && "$(stat -Lc %u "$npm")" == 0 ]] ||
  die ROOT_OWNED_NPM_REQUIRED
# Also verify all parent directories are root-owned and nonwritable:
# an unprivileged user must not swap out the executable after preflight.
python3 - "$node" "$npm" <<'PY' || die ROOT_EXECUTABLE_PATH_UNSAFE
import pathlib,sys
for argument in sys.argv[1:]:
    p=pathlib.Path(argument).resolve(strict=True)
    assert p.is_file()
    for component in [p,*p.parents]:
        meta=component.stat()
        assert meta.st_uid==0 and not (meta.st_mode & 0o022)
PY
avail=$(df -Pk /opt | awk 'NR==2 {print $4}')
[[ "$avail" =~ ^[0-9]+$ && "$avail" -ge 8388608 ]] ||
  die BELOW_8GIB_DISK

state=$(python3 - "$CONFIG" <<'PY'
import json,pathlib,pwd,sys
c=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert c.get("supervisorSocket") is None
assert not c.get("supervisorPipe") and not c.get("supervisorTokenFile")
p=c.get("projects")
assert isinstance(p,list) and len(p)==1
assert p[0].get("id")=="kmj-cloudos"
assert pathlib.Path(p[0].get("root","")).resolve()==pathlib.Path("/home/info/kmj-cloudos")
s=pathlib.Path(c["stateDir"])
assert s.is_absolute() and s.is_dir() and not s.is_symlink()
assert s.stat().st_uid==pwd.getpwnam("info").pw_uid
j=s/"jobs"
assert j.is_dir() and not j.is_symlink()
for f in j.glob("*.json"):
    assert f.is_file() and not f.is_symlink() and f.stat().st_size<=262144
    assert json.loads(f.read_text()).get("state") not in ("running","queued")
print(s)
PY
) || die CONFIG_OR_BUSY_JOB_GUARD_FAILED

# Stage independently from immutable Git object, not the writable agent.
install -d -o root -g root -m 0755 "$BASE"
[[ "$(stat -c %u "$BASE")" == 0 ]] || die STAGE_NOT_ROOT_OWNED
STAGE=$(mktemp -d "$BASE/.stage-XXXXXXXX")
git -C "$STAGE" init -q
env GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  git -C "$STAGE" -c credential.helper= -c core.hooksPath=/dev/null \
  fetch -q --no-tags --depth 1 "$REPO" "$SOURCE_PIN" || die SOURCE_FETCH_FAILED
git -C "$STAGE" -c core.hooksPath=/dev/null checkout -q --detach "$SOURCE_PIN" ||
  die SOURCE_CHECKOUT_FAILED
[[ "$(git -C "$STAGE" rev-parse HEAD)" == "$SOURCE_PIN" &&
   -z "$(git -C "$STAGE" status --porcelain --untracked-files=no)" ]] ||
  die SOURCE_HEAD_CHANGED
[[ "$("$node" -p 'require(process.argv[1]).name' "$STAGE/package.json")" == \
  @kmjtechno/codebridge ]] || die SOURCE_PACKAGE_MISMATCH
"$npm" --prefix "$STAGE" ci --omit=dev --ignore-scripts --no-audit --no-fund ||
  die DEPENDENCY_INSTALL_FAILED
"$node" --check "$STAGE/src/cli.js" || die CLI_PARSE_FAILED
"$node" --test "$STAGE/tests/cloudos-supervisor-profile.test.js" ||
  die CLOUDOS_SUPERVISOR_SOURCE_TEST_FAILED
find "$STAGE" -type d -exec chmod 0555 '{}' +
find "$STAGE" -type f -exec chmod 0444 '{}' +
bad=$(find "$STAGE" -xdev \( -type f -o -type d \) \
  \( ! -user root -o -perm /022 \) -print -quit)
[[ -z "$bad" ]] || die ROOT_STAGE_WRITABLE
while IFS= read -r -d '' link; do
  dest=$(readlink -f "$link" || true)
  [[ "$dest" == "$STAGE/"* ]] || die ROOT_STAGE_SYMLINK_ESCAPE
done < <(find "$STAGE" -xdev -type l -print0)
mv -T "$STAGE" "$BASE/$SOURCE_PIN"
STAGE=''

# Narrow root service: only CloudOS agent is controllable by the info-owned
# private socket. Both home bind mounts are explicitly read-only.
temp_service=$(mktemp /etc/systemd/system/.cloudos-supervisor-service-XXXXXXXX)
temp_socket=$(mktemp /etc/systemd/system/.cloudos-supervisor-socket-XXXXXXXX)
cat >"$temp_service" <<EOF
[Unit]
Description=KMJ CloudOS restricted Supervisor
Requires=$SOCKET_UNIT
After=$SOCKET_UNIT

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$BASE/$SOURCE_PIN
ExecStart=$node $BASE/$SOURCE_PIN/src/cli.js supervisor
Environment=KMJ_CODEBRIDGE_SUPERVISOR_PROFILE=cloudos
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=tmpfs
BindReadOnlyPaths=/home/info/.config/kmj-codebridge /home/info/kmj-cloudos
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
EOF
cat >"$temp_socket" <<EOF
[Unit]
Description=KMJ CloudOS private Supervisor socket

[Socket]
ListenStream=$SOCKET
SocketUser=info
SocketGroup=info
SocketMode=0600
DirectoryMode=0711
RemoveOnStop=yes
Service=$SERVICE_UNIT

[Install]
WantedBy=sockets.target
EOF
chmod 0644 "$temp_service" "$temp_socket"
[[ ! -e "/etc/systemd/system/$SOCKET_UNIT" &&
   ! -e "/etc/systemd/system/$SERVICE_UNIT" ]] ||
  die CONCURRENT_SUPERVISOR_INSTALL
mv -n "$temp_service" "/etc/systemd/system/$SERVICE_UNIT"
mv -n "$temp_socket" "/etc/systemd/system/$SOCKET_UNIT"
UNITS_INSTALLED=1
systemctl daemon-reload
systemd-analyze verify "$SERVICE_UNIT" "$SOCKET_UNIT" ||
  die SYSTEMD_UNIT_VERIFY_FAILED
systemctl enable --now "$SOCKET_UNIT" || die SOCKET_ENABLE_FAILED
[[ -S "$SOCKET" && "$(stat -c %U:%a "$SOCKET")" == info:600 ]] ||
  die SOCKET_OWNER_OR_MODE_WRONG

runuser -u info -- python3 - "$SOCKET" <<'PY' || die LIVE_SUPERVISOR_RPC_FAILED
import json,socket,sys
def request(obj):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as sock:
        sock.settimeout(5)
        sock.connect(sys.argv[1])
        sock.sendall(json.dumps(obj).encode()+b"\n")
        response=b""
        while not response.endswith(b"\n") and len(response)<65536:
            part=sock.recv(4096)
            if not part: break
            response+=part
    data=json.loads(response)
    assert data.get("ok") is True
    return data["result"]
assert request({"op":"status","service":"agent"})["activeState"]=="active"
assert request({"op":"config_validate","service":"agent"})["valid"] is True
assert request({"op":"project_status","projectId":"kmj-cloudos"})["gitCheckout"] is True
PY

# Preserve all gateway credentials and task/worker settings; add only the
# canonical Supervisor socket property, then verify fresh agent reconnect.
BACKUP="$(dirname "$CONFIG")/.before-supervisor-$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$BACKUP" ]] || die BACKUP_CONFLICT
install -o info -g info -m 0600 "$CONFIG" "$BACKUP"
old_hash=$(sha256sum "$CONFIG" | cut -d' ' -f1)
NEWCFG=$(mktemp "$(dirname "$CONFIG")/.supervisor-patch-XXXXXXXX")
python3 - "$CONFIG" "$NEWCFG" <<'PY' || die CONFIG_PATCH_FAILED
import json,pathlib,sys
source,target=map(pathlib.Path,sys.argv[1:])
c=json.loads(source.read_text())
assert c.get("supervisorSocket") is None
c["supervisorSocket"]="/run/kmj-codebridge/supervisor.sock"
target.write_text(json.dumps(c,indent=2)+"\n")
PY
chown info:info "$NEWCFG"
chmod 0600 "$NEWCFG"
if ! "$node" --input-type=module - "$NEWCFG" "$RUNTIME" <<'JS'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const obj=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const module=await import(pathToFileURL(process.argv[3]+'/src/config.js').href);
module.enrolledAgentSchema.parse(obj);
JS
then
  die NEW_CONFIG_SCHEMA_INVALID
fi
[[ "$(sha256sum "$CONFIG" | cut -d' ' -f1)" == "$old_hash" ]] ||
  die CONCURRENT_CONFIG_CHANGE
mv -f "$NEWCFG" "$CONFIG"
NEWCFG=''
CONFIG_CHANGED=1
started=$(date +%s)
systemctl restart "$UNIT" || die AGENT_RESTART_FAILED
connected=0
for _ in $(seq 1 35); do
  if systemctl is-active --quiet "$UNIT" && python3 - "$state" "$started" <<'PY'
import datetime,json,pathlib,sys
p=pathlib.Path(sys.argv[1])/"connection.json"
try:
    obj=json.loads(p.read_text())
    timestamp=datetime.datetime.fromisoformat(obj["connectedAt"].replace("Z","+00:00")).timestamp()
    assert timestamp>=int(sys.argv[2])-1 and p.stat().st_mtime>=int(sys.argv[2])-1
except (OSError,KeyError,ValueError,AssertionError):
    raise SystemExit(1)
PY
  then connected=1; break; fi
  sleep 1
done
[[ "$connected" == 1 ]] || die FRESH_AGENT_CONNECTION_NOT_VERIFIED
for unit in kmj-cloudos-api.service kmj-cloudos-worker.service; do
  systemctl is-active --quiet "$unit" || die CLOUDOS_SERVICE_CHANGED
done
SUCCESS=1
echo "CLOUDOS_SUPERVISOR_BOOTSTRAP=PASS"
echo "ROOT_RUNTIME_SHA=$SOURCE_PIN"
echo "SOCKET_OWNER=info"
echo "CLOUDOS_AGENT_FRESH_CONNECTION=PASS"
echo "ORIGINAL_ENROLLMENT_AND_WORKTREE=PRESERVED"
echo "BACKUP_KEPT_FOR_ROLLBACK=YES"
