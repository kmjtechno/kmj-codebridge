#!/usr/bin/env bash
# KMJ CloudOS Google VPS / rootless agent guarded upgrade (operator-executed).
# Exact source SHA, no re-enrollment, no Supervisor installation, no CloudOS writes.
set -Eeuo pipefail
umask 077
UNIT=kmj-codebridge-cloudos.service
AGENT_USER=info
BASE=/home/info/.local/share/kmj-codebridge
RUNTIME=$BASE/runtime-v0.3.2-20261012
CONFIG=/home/info/.config/kmj-codebridge/agent.json
OLD_PIN=dea0a6e398cd4706ddc61e314174314b9a6f95ee
PIN=9584b584c9a94545fb9dc750c9dfef5bf4f7978a
# This specific stable release has an independently owner-signed manifest.
RELEASE_METADATA_COMMIT=37c0669b08d6a3d04e346fa5532066a28ee27427
RELEASE_METADATA_BASE=https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$RELEASE_METADATA_COMMIT/releases/stable/$PIN
RELEASE_ARCHIVE=https://kmjtechno.com/codebridge/releases/stable/$PIN/kmj-codebridge-0.3.2-9584b584c9a9.tar.gz
REPO=https://github.com/kmjtechno/kmj-codebridge.git
STAGE=""
BACKUP=""
FAILED=""
SWAPPED=0
VERIFIED=0
die() { echo "KMJ_CLOUDOS_UPGRADE_BLOCKED=$1" >&2; exit 1; }
finish() {
  local rc=$?
  trap - EXIT
  if (( SWAPPED == 1 && VERIFIED == 0 )); then
    echo "AGENT_RUNTIME_ROLLBACK=START"
    systemctl stop "$UNIT" >/dev/null 2>&1 || true
    if [[ -d "$RUNTIME" && ! -e "$FAILED" ]]; then
      mv -- "$RUNTIME" "$FAILED" || true
    fi
    if [[ -d "$BACKUP" && ! -e "$RUNTIME" ]]; then
      mv -- "$BACKUP" "$RUNTIME" || true
    fi
    systemctl start "$UNIT" >/dev/null 2>&1 || true
    if systemctl is-active --quiet "$UNIT"; then
      echo "AGENT_RUNTIME_ROLLBACK=OLD_AGENT_ACTIVE"
    else
      echo "AGENT_RUNTIME_ROLLBACK=SERVICE_REQUIRES_ATTENTION" >&2
    fi
  fi
  if [[ -n "$STAGE" && "$STAGE" == "$BASE"/.stage-cloudos-* && -d "$STAGE" ]]; then
    rm -rf -- "$STAGE"
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cloudos_services_healthy() {
  for service in kmj-cloudos-api.service kmj-cloudos-worker.service; do
    systemctl is-active --quiet "$service" || return 1
  done
}

[[ "$EUID" -eq 0 ]] || die ROOT_REQUIRED
[[ "$(hostname)" == google-vps1 ]] || die WRONG_HOST
[[ "$(systemctl show -p ActiveState --value "$UNIT")" == active ]] || die AGENT_NOT_ACTIVE
cloudos_services_healthy || die CLOUDOS_SERVICES_NOT_ACTIVE_PRE
[[ "$(systemctl show -p User --value "$UNIT")" == "$AGENT_USER" ]] || die SERVICE_USER_CHANGED
[[ "$(systemctl show -p WorkingDirectory --value "$UNIT")" == "$RUNTIME" ]] || die RUNTIME_PATH_CHANGED
[[ "$(systemctl show -p FragmentPath --value "$UNIT")" == /etc/systemd/system/kmj-codebridge-cloudos.service ]] || die UNIT_PATH_CHANGED
[[ -d "$RUNTIME" && ! -L "$RUNTIME" && -d "$BASE" && ! -L "$BASE" ]] || die RUNTIME_UNSAFE
[[ -f "$RUNTIME/src/cli.js" && -f "$CONFIG" && ! -L "$CONFIG" ]] || die CONFIG_OR_RUNTIME_MISSING
[[ "$(stat -c %u "$RUNTIME")" == "$(id -u "$AGENT_USER")" ]] || die RUNTIME_OWNERSHIP
[[ "$(stat -c %u "$BASE")" == "$(id -u "$AGENT_USER")" ]] || die BASE_OWNERSHIP
[[ "$(stat -c %u "$CONFIG")" == "$(id -u "$AGENT_USER")" ]] || die CONFIG_OWNERSHIP
[[ "$(stat -c %a "$CONFIG")" == 600 ]] || die CONFIG_MODE_CHANGED
[[ "$(git -C "$RUNTIME" rev-parse HEAD)" == "$OLD_PIN" ]] || die OLD_RUNTIME_PIN_CHANGED
[[ -z "$(git -C "$RUNTIME" status --porcelain --untracked-files=no)" ]] || die OLD_RUNTIME_DIRTY
systemctl is-active --quiet kmj-codebridge-supervisor.socket || die SUPERVISOR_SOCKET_INACTIVE
[[ -S /run/kmj-codebridge/supervisor.sock &&
   "$(stat -c %U:%a /run/kmj-codebridge/supervisor.sock)" == info:600 ]] ||
  die SUPERVISOR_SOCKET_UNVERIFIED
PID="$(systemctl show -p MainPID --value "$UNIT")"
[[ "$PID" =~ ^[1-9][0-9]*$ && -r "/proc/$PID/cmdline" ]] || die AGENT_PID_MISSING
NODE="$(readlink -f "/proc/$PID/exe")"
[[ -x "$NODE" ]] || die NODE_UNAVAILABLE
[[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" == 24 ]] || die NODE24_REQUIRED
NODE_DIR="$(dirname "$NODE")"
NPM="$NODE_DIR/npm"
if [[ ! -x "$NPM" ]]; then NPM="$(command -v npm || true)"; fi
[[ -n "$NPM" && -x "$NPM" ]] || die NPM_MISSING

# Verify live ExecStart identity, without printing command args or secrets.
python3 - "$PID" "$RUNTIME" "$CONFIG" <<'PY' || die WRONG_AGENT_PROCESS
from pathlib import Path
import sys
pid, runtime, config = sys.argv[1:]
args = [a.decode('utf-8', 'replace') for a in
        Path('/proc/' + pid + '/cmdline').read_bytes().split(b'\0') if a]
assert str(Path(runtime) / 'src/cli.js') in args
assert 'agent' in args
assert config in args
PY

STATE="$(python3 - "$CONFIG" <<'PY'
import json, stat, sys
from pathlib import Path
p = Path(sys.argv[1]); meta = p.lstat()
assert stat.S_ISREG(meta.st_mode) and meta.st_size < 131072
cfg = json.loads(p.read_text())
assert isinstance(cfg.get('token'), str) and len(cfg['token']) >= 32
assert any(x.get('id') == 'kmj-cloudos' and x.get('writable') is True
           for x in cfg.get('projects', []))
state = cfg.get('stateDir', '')
assert state.startswith('/home/info/') and '..' not in Path(state).parts
assert Path(state).is_dir() and not Path(state).is_symlink()
print(state)
PY
)" || die CONFIG_INVALID
[[ -n "$STATE" ]] || die STATE_UNAVAILABLE
CONFIG_SHA="$(sha256sum "$CONFIG" | cut -d' ' -f1)"

# Fail closed on active or pending CodeBridge QA; autopilot backlog is preserved.
check_jobs() {
  python3 - "$STATE" <<'PY'
import json, sys
from pathlib import Path
directory = Path(sys.argv[1]) / 'jobs'
for f in directory.glob('*.json'):
    try:
        data = json.loads(f.read_text())
    except (OSError, ValueError):
        raise SystemExit(1)
    if data.get('state') in ('queued', 'running'):
        raise SystemExit(1)
PY
}
check_jobs || die ACTIVE_QA_JOB
FREE_KB="$(df -Pk "$BASE" | awk 'NR==2 {print $4}')"
[[ "$FREE_KB" =~ ^[0-9]+$ && "$FREE_KB" -ge 7340032 ]] || die DISK_SPACE_LOW
STAGE="$(runuser -u "$AGENT_USER" -- mktemp -d "$BASE/.stage-cloudos-XXXXXXXX")" || die STAGE_CREATE_FAILED
[[ "$STAGE" == "$BASE"/.stage-cloudos-* && -d "$STAGE" ]] || die STAGE_UNSAFE

echo "UPGRADE_PREFLIGHT=PASS"
echo "PINNED_SOURCE_SHA=$PIN"
echo "PRESERVE_ENROLLMENT=YES"
echo "CLOUDOS_CHECKOUT_UNCHANGED=YES"
runuser -u "$AGENT_USER" -- git clone -q --no-tags "$REPO" "$STAGE" || die CLONE_FAILED
runuser -u "$AGENT_USER" -- git -C "$STAGE" checkout -q --detach "$PIN" || die PIN_MISSING
[[ "$(runuser -u "$AGENT_USER" -- git -C "$STAGE" rev-parse HEAD)" == "$PIN" ]] || die SOURCE_SHA_MISMATCH
[[ "$(runuser -u "$AGENT_USER" -- git -C "$STAGE" remote get-url origin)" == "$REPO" ]] || die SOURCE_ORIGIN_MISMATCH
[[ -z "$(runuser -u "$AGENT_USER" -- git -C "$STAGE" status --porcelain --untracked-files=no)" ]] || die SOURCE_DIRTY
[[ "$("$NODE" -p 'require(process.argv[1]).name' "$STAGE/package.json")" == @kmjtechno/codebridge ]] || die PACKAGE_MISMATCH

# Signed stable seq33 authentication is separate from Git SHA/pin checks.
# The public PEM is harmless; the owner private Ed25519 key is never used.
# An unsigned Git branch, archive without the exact signature, or paid fallback
# cannot authorize the agent swap. All work is in the rootless disposable stage.
RELEASE_DIR="$STAGE/.kmj-signed-release-check"
[[ ! -e "$RELEASE_DIR" ]] || die SIGNED_STAGE_CONFLICT
runuser -u "$AGENT_USER" -- mkdir -m 0700 -- "$RELEASE_DIR" || die SIGNED_STAGE_FAILED
runuser -u "$AGENT_USER" -- curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 \
  "$RELEASE_METADATA_BASE/release-manifest.json" -o "$RELEASE_DIR/manifest.json" ||
  die SIGNED_MANIFEST_UNAVAILABLE
runuser -u "$AGENT_USER" -- curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 \
  "$RELEASE_METADATA_BASE/release-manifest.sig" -o "$RELEASE_DIR/manifest.sig" ||
  die SIGNED_SIGNATURE_UNAVAILABLE
runuser -u "$AGENT_USER" -- curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 \
  "$RELEASE_ARCHIVE" -o "$RELEASE_DIR/archive.tar.gz" ||
  die SIGNED_ARCHIVE_UNAVAILABLE
runuser -u "$AGENT_USER" -- "$NODE" --input-type=module - "$RELEASE_DIR" "$PIN" <<'JS' ||
  die OWNER_ED25519_RELEASE_UNVERIFIED
import fs from "node:fs";
import path from "node:path";
import {createHash,createPublicKey,verify} from "node:crypto";
const [root,revision]=process.argv.slice(2);
const read=(name,limit)=>{
 const file=path.join(root,name),st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1||st.size>limit)throw Error("UNTRUSTED_FILE");
 return fs.readFileSync(file);
};
const manifest=read("manifest.json",65536);
const signature=read("manifest.sig",1024).toString("ascii").trim();
const archive=read("archive.tar.gz",2500000);
const sha=x=>createHash("sha256").update(x).digest("hex");
const publicKey=createPublicKey("-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA5KblzKLYvHE1FwJHOCITtn4BTHjy8QADSGKU/9HH+7E=\n-----END PUBLIC KEY-----\n");
if(publicKey.asymmetricKeyType!=="ed25519"||sha(publicKey.export({format:"der",type:"spki"}))!=="2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8")throw Error("TRUST_KEY");
if(sha(manifest)!=="1d19f0e2163fa764432c1612914fef5215ba30cdc26e87f9e41a28342d016bc7")throw Error("MANIFEST_PIN");
if(!/^[A-Za-z0-9_-]{86}$/.test(signature))throw Error("SIGNATURE_FORMAT");
const bytes=Buffer.from(signature,"base64url");
if(bytes.length!==64||bytes.toString("base64url")!==signature||!verify(null,manifest,publicKey,bytes))throw Error("BAD_SIGNATURE");
const m=JSON.parse(manifest.toString("utf8"));
if(m.schema!==1||m.product!=="KMJ CodeBridge"||m.channel!=="stable"||m.keyId!=="kmj-release-2026"||m.revision!==revision||m.sequence!==33||m.version!=="0.3.2"||m.nodeMajor!==24)throw Error("RELEASE_IDENTITY");
if(m.archive!=="https://kmjtechno.com/codebridge/releases/stable/"+revision+"/kmj-codebridge-0.3.2-"+revision.slice(0,12)+".tar.gz")throw Error("ARCHIVE_URL");
if(m.sha256!=="32320e772aa1167a8ddefbd036dd2b95c9bf565608426c624de4d01173742ca0"||m.bytes!==2483840||archive.length!==m.bytes||sha(archive)!==m.sha256)throw Error("ARCHIVE_HASH");
console.log("OWNER_ED25519_SIGNED_SEQ33=PASS");
console.log("SIGNED_ARCHIVE_DIGEST=PASS");
JS
# Delete only these fixed newly created public artifacts before runtime swap.
runuser -u "$AGENT_USER" -- rm -f -- "$RELEASE_DIR/manifest.json" "$RELEASE_DIR/manifest.sig" "$RELEASE_DIR/archive.tar.gz" ||
  die SIGNED_ARTIFACT_CLEANUP_FAILED
runuser -u "$AGENT_USER" -- rmdir -- "$RELEASE_DIR" || die SIGNED_ARTIFACT_CLEANUP_FAILED


runuser -u "$AGENT_USER" -- env PATH="$NODE_DIR:$PATH" "$NPM" --prefix "$STAGE" ci --ignore-scripts --no-audit --no-fund || die NPM_CI_FAILED
runuser -u "$AGENT_USER" -- env PATH="$NODE_DIR:$PATH" "$NPM" --prefix "$STAGE" run check || die CHECK_FAILED
runuser -u "$AGENT_USER" -- env PATH="$NODE_DIR:$PATH" "$NPM" --prefix "$STAGE" test || die TEST_FAILED
runuser -u "$AGENT_USER" -- env PATH="$NODE_DIR:$PATH" "$NPM" --prefix "$STAGE" prune --omit=dev --ignore-scripts --no-audit --no-fund || die PRUNE_FAILED
"$NODE" --check "$STAGE/src/cli.js" || die SYNTAX_FAILED
[[ "$(sha256sum "$CONFIG" | cut -d' ' -f1)" == "$CONFIG_SHA" ]] || die ENROLLMENT_CHANGED
check_jobs || die NEW_ACTIVE_QA_JOB

BACKUP="$BASE/.rollback-cloudos-$(date -u +%Y%m%dT%H%M%SZ)"
FAILED="$BASE/.failed-cloudos-$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$BACKUP" && ! -e "$FAILED" ]] || die BACKUP_NAME_CONFLICT
mv -- "$RUNTIME" "$BACKUP" || die OLD_RUNTIME_MOVE_FAILED
SWAPPED=1
mv -- "$STAGE" "$RUNTIME" || die NEW_RUNTIME_MOVE_FAILED
STAGE=""
START_EPOCH="$(date +%s)"
systemctl restart "$UNIT" || die SERVICE_RESTART_FAILED

CONNECTED=0
for _ in $(seq 1 35); do
  if systemctl is-active --quiet "$UNIT" && python3 - "$STATE" "$START_EPOCH" <<'PY'
import json, sys
from datetime import datetime
from pathlib import Path
p = Path(sys.argv[1]) / 'connection.json'
try:
    data = json.loads(p.read_text())
    connected = datetime.fromisoformat(
        data['connectedAt'].replace('Z', '+00:00')).timestamp()
    assert connected >= int(sys.argv[2]) - 1
    assert p.stat().st_mtime >= int(sys.argv[2]) - 1
except (OSError, ValueError, AssertionError, KeyError):
    raise SystemExit(1)
PY
  then CONNECTED=1; break; fi
  sleep 1
done
[[ "$CONNECTED" -eq 1 ]] || die FRESH_GATEWAY_HEARTBEAT_MISSING
cloudos_services_healthy || die CLOUDOS_SERVICES_NOT_ACTIVE_POST
[[ "$(sha256sum "$CONFIG" | cut -d' ' -f1)" == "$CONFIG_SHA" ]] || die ENROLLMENT_CHANGED_POST_RESTART
VERIFIED=1
echo "KMJ_CLOUDOS_AGENT_UPGRADE=PASS"
echo "NEW_RUNTIME_SHA=$PIN"
echo "GATEWAY=FRESH_CONNECTED"
echo "PREVIOUS_RUNTIME=PRESERVED_FOR_ROLLBACK"
echo "SUPERVISOR_STATUS=EXISTING_SOCKET_LEFT_UNCHANGED"
echo "NEXT=REMOTE_CODEBRIDGE_CLOUDOS_COMMAND_VERIFICATION"
