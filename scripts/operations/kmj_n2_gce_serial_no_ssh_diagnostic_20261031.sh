#!/usr/bin/env bash
# No-SSH, read-only N2 host health investigation after IAP TCP/22 backend failure.
# Does not contact the VM's guest OS, reboot, add firewall rules or change metadata.
set -Eeuo pipefail
umask 077
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
TMP="$(mktemp -d "$HOME/.kmj-n2-no-ssh-XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT
echo KMJ_N2_POST_IAP_BACKEND_FAILURE_GCE_SERIAL_DIAGNOSTIC_V1
echo SCOPE=COMPUTE_API_ONLY_NO_SSH_NO_VM_MUTATION
timeout 45s gcloud compute instances describe "$VM" \
  --project="$PROJECT" --zone="$ZONE" --format=json >"$TMP/instance.json"
python3 - "$TMP/instance.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
if d.get('name')!='kmj-cloudos-kvm-test' or not d.get('zone','').endswith('/us-central1-a'):
 raise ValueError('UNEXPECTED_COMPUTE_IDENTITY')
if not d.get('machineType','').endswith('/n2-standard-2'):
 raise ValueError('UNEXPECTED_MACHINE_CLASS')
if d.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is not True:
 raise ValueError('NESTED_KVM_CONFIG_CHANGED')
print('GCE_INSTANCE_IDENTITY=PASS')
print('GCE_STATUS='+str(d.get('status','UNKNOWN')))
print('GCE_LAST_START='+str(d.get('lastStartTimestamp','NOT_REPORTED')))
print('GCE_LAST_STOP='+str(d.get('lastStopTimestamp','NOT_REPORTED')))
print('GCE_LAST_SUSPEND='+str(d.get('lastSuspendedTimestamp','NOT_REPORTED')))
print('GCE_LAST_RESUME='+str(d.get('lastResumedTimestamp','NOT_REPORTED')))
print('GCE_NETWORK_INTERFACE_COUNT='+str(len(d.get('networkInterfaces') or [])))
print('GCE_NETWORK_TAG_COUNT='+str(len(d.get('tags',{}).get('items') or [])))
PY
echo ACTION=READ_SERIAL_PORT_1_WITHOUT_SSH
if timeout 55s gcloud compute instances get-serial-port-output "$VM" \
 --project="$PROJECT" --zone="$ZONE" --port=1 >"$TMP/serial.txt" 2>"$TMP/serial.err"; then
 echo GCE_SERIAL_PORT1_API=PASS
 python3 - "$TMP/serial.txt" <<'PY'
from pathlib import Path
import collections,re,sys
s=Path(sys.argv[1]).read_text(errors='replace')
lines=s.splitlines()
print('SERIAL_BYTES='+str(len(s.encode('utf-8'))))
print('SERIAL_LINES='+str(len(lines)))
patterns={
 'OUT_OF_MEMORY':re.compile(r'out of memory|oom-kill|oom_reaper|killed process|memory cgroup out of memory|systemd-oomd',re.I),
 'KERNEL_PANIC':re.compile(r'kernel panic|not syncing|BUG: soft lockup|watchdog:.*hard LOCKUP',re.I),
 'FILESYSTEM_READONLY_OR_IO':re.compile(r'EXT4-fs error|I/O error|remounting filesystem read-only|No space left on device',re.I),
 'SSH_SERVICE_FAILURE':re.compile(r'(ssh|sshd).*?(failed|failure|timed out|terminated|stopped|killed)|failed to start.*(ssh|sshd)',re.I),
 'GUEST_AGENT_FAILURE':re.compile(r'google-guest-agent.*?(fail|error|stopp|kill)',re.I),
 'BOOT_SIGNAL':re.compile(r'Linux version |Booting Linux|systemd\[1\]:.*(running in system mode|startup finished)|Reached target.*multi-user',re.I),
}
for name,p in patterns.items():
 matches=[i for i,line in enumerate(lines) if p.search(line)]
 print('SIGNAL_'+name+'_COUNT='+str(len(matches)))
 for idx in matches[-4:]:
  line=lines[idx]
  # Print only a recognized rough timestamp, never raw serial messages.
  t=re.search(r'^\s*(?:\[\s*\d+(?:\.\d+)?\s*\]|\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d|\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d)',line)
  print('SIGNAL_'+name+'_LAST_AT_LINE='+str(idx+1)+'_TIME='+(t.group(0).strip() if t else 'NOT_DETECTED'))
last=[x for x in lines[-100:] if x.strip()]
print('SERIAL_TAIL_LINES_NONEMPTY='+str(len(last)))
print('RESULT=GCE_STATUS_AND_SANITIZED_SERIAL_REVIEW_COMPLETE')
PY
else
 echo GCE_SERIAL_PORT1_API=FAILED
 python3 - "$TMP/serial.err" <<'PY'
from pathlib import Path
import re,sys
s=Path(sys.argv[1]).read_text(errors='replace')
for tag,pattern in {
 'IAM_OR_PERMISSION':r'PERMISSION_DENIED|permission|not authorized|403',
 'VM_NOT_RUNNING':r'is not running|not found|was not found|404',
 'RATE_OR_API_ERROR':r'quota|429|500|503|unavailable',
}.items():
 print('SERIAL_ERROR_'+tag+'='+str(bool(re.search(pattern,s,re.I))))
PY
 echo RESULT=GCE_STATUS_VERIFIED_SERIAL_API_UNAVAILABLE
fi
echo NO_GCE_RESOURCE_MUTATIONS=YES
echo RECEIPT_COMPLETE=YES
