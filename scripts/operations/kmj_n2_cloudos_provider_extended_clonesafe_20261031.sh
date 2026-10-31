#!/usr/bin/env bash
# Real CloudOS provider EXTENDED smoke, using already-verified private source on N2.
# No GCE resources or network/firewall changes; only isolated temporary test VMs.
set -Eeuo pipefail
umask 077
HOST=kmj-cloudos-kvm-test
ROOT=/var/lib/libvirt/images/kmj-cloudos-ci
WORK="$ROOT/provider-smoke-20261031-v1"
VMS="$WORK/vms"
BASE="$ROOT/qga-clone-sanitized-20261031-v1.qcow2"
BASE_REPORT="$ROOT/guest-identity-sanitize-20261031-v1/report.json"
BASIC_REPORT="$WORK/evidence/permission-fix-v2/provider-report.json"
OUT="$WORK/evidence/extended-clonesafe-v1/provider-report.json"
URI=qemu:///system
echo KMJ_CLOUDOS_N2_REAL_PROVIDER_CLONE_SAFE_EXTENDED_V2
echo SCOPE=ONE_EXISTING_N2_LAB_DISPOSABLE_GUESTS_NO_GCE_MUTATIONS
test "$(hostname -s)" = "$HOST"
test "$(id -u)" -eq 0
test -c /dev/kvm
test "$(id -u libvirt-qemu)" = 64055
test "$(id -g libvirt-qemu)" = 993
command -v qemu-img >/dev/null
command -v virsh >/dev/null
python3 -c 'import defusedxml'
echo KVM_AND_QEMU_IDENTITY=PASS
test -f "$BASE" && test ! -L "$BASE"
test -f "$BASE_REPORT" && test ! -L "$BASE_REPORT"
test -f "$BASIC_REPORT" && test ! -L "$BASIC_REPORT"
test -d "$WORK" && test ! -L "$WORK"
test -d "$VMS" && test ! -L "$VMS"
test "$(stat -c '%u:%g:%a' "$WORK")" = 0:0:711
test "$(stat -c '%u:%g:%a' "$VMS")" = 0:993:2750
runuser -u libvirt-qemu -- test -x "$WORK"
runuser -u libvirt-qemu -- test -x "$VMS"
runuser -u libvirt-qemu -- test -r "$BASE"
echo QEMU_PRIVATE_TEST_PATH_ACCESS=PASS
python3 - "$BASE" "$BASE_REPORT" "$BASIC_REPORT" "$WORK" <<'PY'
import hashlib,json,pathlib,sys
base,base_report,basic_report,work=map(pathlib.Path,sys.argv[1:])
b=json.loads(base_report.read_text());p=json.loads(basic_report.read_text())
assert b.get('status')=='PASS' and b.get('guest_agent') is True and b.get('clean_shutdown') is True
h=hashlib.sha256()
with base.open('rb') as f:
 for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
assert h.hexdigest()==b['prepared_image_sha256']
assert p.get('status')=='PASS' and p.get('guest_agent_ready') is True and p.get('release_gate_credit') is False
checks=p.get('checks',{})
for key in ('libvirt_create','actual_domain_running','qga_guest_ping_osinfo_and_ip',
            'idempotent_reuse','ownership_metadata_and_overlay','allocation_scope','delete_no_orphan'):
 assert checks.get(key)=='PASS',key
expected={
'src/hypervisor/runtime/provider.py':'1fb38a1676cb1369a17e45ec689a85317718fd53',
'src/hypervisor/runtime/libvirt_provider.py':'971e6e6eccc8aef80824abf8b938019a199499c5',
'scripts/ci_libvirt_provider_smoke.py':'e48d474358dc1c489b0c9d19861877634d74b42d',
'scripts/ci_libvirt_lifecycle_checks.py':'f7cce02f079228b8b64fafcaa3533a859102edda'
}
for name,blob in expected.items():
 f=work/name
 assert f.is_file() and not f.is_symlink()
 raw=f.read_bytes()
 assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==blob
print('VERIFIED_CLONE_SAFE_QGA_BASE_AND_BASIC_PROVIDER_REPORT=PASS')
print('PRIVATE_CLOUDOS_SOURCE_GIT_BLOBS=PASS')
PY
DOMAINS="$(timeout 15s virsh -c "$URI" list --all --name)"
test -z "$DOMAINS" || { echo BLOCKED=EXISTING_LIBVIRT_DOMAINS;exit 4; }
if find "$VMS" -maxdepth 1 -type f -name '*.qcow2' -print -quit | grep -q .; then
 echo BLOCKED=PREEXISTING_TEST_OVERLAY
 exit 4
fi
echo PREEXISTING_DOMAINS_AND_OVERLAYS=0
NETINFO="$(mktemp /tmp/kmj-cloudos-extended-net.XXXXXXXX)"
trap 'rm -f "$NETINFO"' EXIT
timeout 15s virsh -c "$URI" net-info default >"$NETINFO"
python3 - "$NETINFO" <<'PY'
from pathlib import Path
import sys
data={}
for line in Path(sys.argv[1]).read_text().splitlines():
 if ':' in line:
  a,b=line.split(':',1);data[a.strip().lower()]=b.strip().lower()
assert data.get('name')=='default' and data.get('active')=='yes' and data.get('bridge')=='virbr0'
print('EXISTING_DEFAULT_NAT=PASS')
PY
python3 - "$ROOT" <<'PY'
from pathlib import Path
import os,shutil,sys
mem={}
for line in Path('/proc/meminfo').read_text().splitlines():
 if ':' in line:
  k,v=line.split(':',1);mem[k]=int(v.strip().split()[0])
assert mem.get('MemAvailable',0)>3*1024*1024,'INSUFFICIENT_HOST_RAM'
assert shutil.disk_usage(sys.argv[1]).free>6*1024**3,'INSUFFICIENT_DISK_SPACE'
assert os.cpu_count() is not None and os.cpu_count()>=2,'INSUFFICIENT_HOST_CPU'
print('EXTENDED_TWO_GUEST_RESOURCE_HEADROOM=PASS')
PY
test ! -e "$WORK/evidence/extended-clonesafe-v1" || { echo BLOCKED=EXTENDED_REPORT_ALREADY_EXISTS;exit 5; }
install -d -m 0700 "$WORK/evidence/extended-clonesafe-v1"
echo ACTION=REAL_PROVIDER_GRACEFUL_RESTART_MULTIPROCESS_TENANT_ISOLATION_FAILURE_RETRY
set +e
(
  umask 0007
  PYTHONPATH="$WORK" timeout --signal=TERM --kill-after=40s 1000s \
    python3 -u "$WORK/scripts/ci_libvirt_provider_smoke.py" \
    --base "$BASE" --storage-dir "$VMS" --output "$OUT" \
    --request-key n2-extended-clonesafe-20261031-v1 \
    --require-guest-agent --guest-agent-timeout-seconds 240 \
    --exercise-graceful-restart \
    --exercise-multiprocess-idempotency \
    --exercise-tenant-isolation \
    --exercise-failed-create-retry
)
RC="$?"
set -e
echo "EXTENDED_PROVIDER_SMOKE_EXIT_CODE=$RC"
if [ -f "$OUT" ] && [ ! -L "$OUT" ]; then
 python3 - "$OUT" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]))
print('STATUS='+str(v.get('status')))
print('GUEST_AGENT_READY='+str(v.get('guest_agent_ready')))
for k,val in sorted(v.get('checks',{}).items()):
 print('CHECK_'+k.upper()+'='+str(val))
for k in ('multiprocess_idempotency','tenant_isolation','graceful_restart','failed_define_retry'):
 d=v.get(k)
 print('DETAIL_'+k.upper()+'='+str(d.get('status') if isinstance(d,dict) else 'MISSING'))
if v.get('failure_code'):print('FAILURE_CODE='+str(v['failure_code'])[:180])
print('RELEASE_GATE_CREDIT='+str(v.get('release_gate_credit')))
PY
else echo BLOCKED=EXTENDED_PROVIDER_REPORT_MISSING;fi
FINAL="$(timeout 15s virsh -c "$URI" list --all --name)"
if [ -n "$FINAL" ]; then echo FINAL_LIBVIRT_DOMAINS_NONZERO_REVIEW_REQUIRED;else echo FINAL_LIBVIRT_DOMAINS=0;fi
echo "EVIDENCE_PATH=$OUT"
if [ "$RC" -ne 0 ] || [ -n "$FINAL" ]; then
 echo RESULT=EXTENDED_PROVIDER_TEST_REQUIRES_REVIEW
 exit 8
fi
python3 - "$OUT" <<'PY'
import json,sys
j=json.load(open(sys.argv[1]))
assert j.get('status')=='PASS'
for k in ('graceful_shutdown_restart_qga_disk_identity','process_shared_idempotent_reuse',
          'two_tenant_qga_ip_ownership_isolation','failed_define_safe_retry_qga_no_orphan'):
 assert j.get('checks',{}).get(k)=='PASS',k
assert j.get('release_gate_credit') is False
print('EXTENDED_LIFECYCLE_ALL_FOUR_GATES=PASS')
PY
echo RESULT=REAL_CLOUDOS_EXTENDED_LIFECYCLE_SMOKE_PASS
echo RECEIPT_COMPLETE=YES
