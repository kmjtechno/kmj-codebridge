#!/usr/bin/env bash
# Owner-executed CloudOS rootless CodeBridge Autopilot fast-gate activation.
# Does not install models, run shell recipes, deploy, or touch the CloudOS tree.
set -Eeuo pipefail
umask 077

UNIT=kmj-codebridge-cloudos.service
RUNTIME=/home/info/.local/share/kmj-codebridge/runtime-v0.3.2-20261012
CONFIG=/home/info/.config/kmj-codebridge/agent.json
PIN=dea0a6e398cd4706ddc61e314174314b9a6f95ee
PROJECT=kmj-cloudos
STAGE=''
BACKUP=''
SWAPPED=0
VERIFIED=0

die() { echo "AUTOPILOT_GATE_ACTIVATION=BLOCKED_$1" >&2; exit 1; }

cleanup() {
  local rc=$?
  trap - EXIT
  if (( SWAPPED == 1 && VERIFIED == 0 )); then
    echo "AUTOPILOT_CONFIG_ROLLBACK=START"
    local restore
    restore=$(mktemp "$(dirname "$CONFIG")/.kmj-gate-restore-XXXXXXXX") || restore=''
    if [[ -n "$restore" && -n "$BACKUP" && -f "$BACKUP" ]]; then
      install -o info -g info -m 0600 "$BACKUP" "$restore" &&
        mv -f -- "$restore" "$CONFIG" || true
      systemctl restart "$UNIT" >/dev/null 2>&1 || true
      if systemctl is-active --quiet "$UNIT"; then
        echo "AUTOPILOT_CONFIG_ROLLBACK=OLD_CONFIG_SERVICE_ACTIVE"
      else
        echo "AUTOPILOT_CONFIG_ROLLBACK=SERVICE_REQUIRES_ATTENTION" >&2
      fi
    fi
    [[ -z "$restore" ]] || rm -f -- "$restore"
  fi
  [[ -z "$STAGE" ]] || rm -f -- "$STAGE"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "$(id -u)" -eq 0 ]] || die ROOT_REQUIRED
[[ "$(hostname -s)" == google-vps1 ]] || die WRONG_HOST
[[ "$(curl -fsS --noproxy '*' --connect-timeout 2 --max-time 4 \
  -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/name)" == \
  instance-20260912-094732 ]] || die WRONG_GCE_VM

[[ -f "$CONFIG" && ! -L "$CONFIG" && -d "$RUNTIME" && ! -L "$RUNTIME" ]] ||
  die UNSAFE_CONFIG_OR_RUNTIME
[[ "$(stat -c %U "$CONFIG")" == info ]] || die CONFIG_OWNER_CHANGED
[[ "$(stat -c %a "$CONFIG")" == 600 ]] || die CONFIG_MODE_CHANGED
[[ "$(systemctl show -p User --value "$UNIT")" == info ]] ||
  die SERVICE_USER_CHANGED
[[ "$(systemctl show -p WorkingDirectory --value "$UNIT")" == "$RUNTIME" ]] ||
  die SERVICE_RUNTIME_CHANGED
systemctl is-active --quiet "$UNIT" || die AGENT_NOT_ACTIVE
for service in kmj-cloudos-api.service kmj-cloudos-worker.service; do
  systemctl is-active --quiet "$service" || die CLOUDOS_SERVICE_NOT_ACTIVE
done
[[ "$(git -C "$RUNTIME" rev-parse HEAD)" == "$PIN" ]] ||
  die AGENT_RELEASE_MISMATCH
node_pid=$(systemctl show -p MainPID --value "$UNIT")
[[ "$node_pid" =~ ^[1-9][0-9]*$ ]] || die NODE_PID_MISSING
NODE=$(readlink -f "/proc/$node_pid/exe")
[[ -x "$NODE" ]] || die NODE_UNAVAILABLE
[[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" == 24 ]] ||
  die NODE24_REQUIRED

# Never touch another agent's work or an in-flight QA gate. Inspect only
# bounded JSON receipts in the existing enrolled state directory.
state=$(python3 - "$CONFIG" <<'PY'
import json, pathlib, sys
c=json.loads(pathlib.Path(sys.argv[1]).read_text())
p=c.get('projects')
assert isinstance(p,list) and len(p)==1 and p[0].get('id')=='kmj-cloudos'
assert p[0].get('writable') is True and isinstance(p[0].get('gates',{}).get('fast'),dict)
assert p[0].get('autopilotGateWorker') in (None, {'enabled':True,'gates':['fast'],'isolatedWorktree':True})
assert not p[0].get('autopilotRepairWorker',{}).get('enabled')
assert not p[0].get('autopilotLocalWorker',{}).get('enabled')
assert not p[0].get('autopilotCiWatch',{}).get('enabled')
state=pathlib.Path(c['stateDir']).resolve(strict=True)
assert state.is_dir() and state.is_relative_to(pathlib.Path('/home/info'))
assert state.stat().st_uid==p[0].get('ownerUid',state.stat().st_uid)
for f in (state/'jobs').glob('*.json'):
    assert f.is_file() and not f.is_symlink() and f.stat().st_size <= 262144
    j=json.loads(f.read_text())
    assert j.get('state') not in ('queued','running')
print(state)
PY
) || die CONFIG_OR_JOB_GUARD_FAILED
[[ -n "$state" ]] || die STATE_NOT_VERIFIED

free_kb=$(df -Pk "$RUNTIME" | awk 'NR==2 {print $4}')
[[ "$free_kb" =~ ^[0-9]+$ && "$free_kb" -ge 8388608 ]] ||
  die DISK_BELOW_8GIB
echo "AUTOPILOT_GATE_PREFLIGHT=PASS"
echo "AGENT_SOURCE_SHA=$PIN"
echo "QA_WORKER=FAST_ONLY_ISOLATED"
echo "OTHER_WORKERS=UNCHANGED"
echo "CLOUDOS_SOURCE_DATA=UNTOUCHED"

# Prepare and validate a complete replacement, preserving every enrollment
# field. No tokens or config data are printed.
STAGE=$(mktemp "$(dirname "$CONFIG")/.kmj-gate-stage-XXXXXXXX") ||
  die STAGE_FAILED
python3 - "$CONFIG" "$STAGE" <<'PY'
import json, pathlib, sys
source,dest=map(pathlib.Path,sys.argv[1:])
config=json.loads(source.read_text())
p=config['projects'][0]
p['autopilotGateWorker']={'enabled':True,'gates':['fast'],'isolatedWorktree':True}
dest.write_text(json.dumps(config,indent=2)+'\n')
PY
install -o info -g info -m 0600 "$STAGE" "$STAGE.owner" ||
  die STAGED_OWNERSHIP_FAILED
mv -f -- "$STAGE.owner" "$STAGE"

"$NODE" --input-type=module - "$STAGE" "$RUNTIME" <<'JS' ||
  die NEW_CONFIG_SCHEMA_INVALID
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const module = await import(pathToFileURL(process.argv[3] + '/src/config.js').href);
module.enrolledAgentSchema.parse(config);
JS

before_hash=$(sha256sum "$CONFIG" | cut -d' ' -f1)
BACKUP="$(dirname "$CONFIG")/.kmj-cloudos-gate-backup-$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$BACKUP" ]] || die BACKUP_ALREADY_EXISTS
install -o info -g info -m 0600 "$CONFIG" "$BACKUP" ||
  die BACKUP_FAILED
[[ "$(sha256sum "$CONFIG" | cut -d' ' -f1)" == "$before_hash" ]] ||
  die CONCURRENT_CONFIG_CHANGE
mv -f -- "$STAGE" "$CONFIG" || die CONFIG_SWAP_FAILED
STAGE=''
SWAPPED=1
started_epoch=$(date -u +%s)
systemctl restart "$UNIT" || die SERVICE_RESTART_FAILED

connected=0
for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$UNIT" &&
      python3 - "$state" "$started_epoch" <<'PY'
import datetime,json,pathlib,sys
p=pathlib.Path(sys.argv[1])/'connection.json'
try:
  t=datetime.datetime.fromisoformat(json.loads(p.read_text())['connectedAt'].replace('Z','+00:00')).timestamp()
  assert t >= int(sys.argv[2])-1 and p.stat().st_mtime>=int(sys.argv[2])-1
except (OSError,KeyError,ValueError,AssertionError):
  raise SystemExit(1)
PY
  then connected=1; break; fi
  sleep 1
done
[[ "$connected" -eq 1 ]] || die NEW_AGENT_HEARTBEAT_MISSING
for service in kmj-cloudos-api.service kmj-cloudos-worker.service; do
  systemctl is-active --quiet "$service" || die CLOUDOS_SERVICE_REGRESSION
done
VERIFIED=1
echo "AUTOPILOT_GATE_ACTIVATION=PASS"
echo "WORKER_EXPECTED=FAST_ONLY"
echo "BACKUP_KEPT_FOR_ROLLBACK=YES"
echo "NEXT=VERIFY_LIVE_CODEBRIDGE_WORKER_RUNTIME_AND_QUEUED_GATE"
