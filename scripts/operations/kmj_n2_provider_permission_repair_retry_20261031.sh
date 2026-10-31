#!/usr/bin/env bash
# N2 guest-only permission fix and real CloudOS provider smoke retry.
# Touch only the two already-confirmed root-owned test directories; no production changes.
set -Eeuo pipefail
umask 077
ROOT=/var/lib/libvirt/images/kmj-cloudos-ci
TEST="$ROOT/provider-smoke-20261031-v1"
VM_DIR="$TEST/vms"
OLD_REPORT="$TEST/evidence/provider-report.json"
NEW_REPORT="$TEST/evidence/permission-fix-v2/provider-report.json"
SRC="$TEST"
BASE="$ROOT/qga-prepared.qcow2"
BASE_REPORT="$ROOT/guest-qga-offline-20261031-v1/report.json"
URI=qemu:///system
echo KMJ_CLOUDOS_N2_PROVIDER_PERMISSION_REPAIR_V1
echo SCOPE=ONLY_TWO_PREEXISTING_TEST_DIRECTORIES
test "$(id -u)" = 0
test "$(hostname -s)" = kmj-cloudos-kvm-test
test -c /dev/kvm
test "$(id -u libvirt-qemu)" = 64055
test "$(id -g libvirt-qemu)" = 993
echo QEMU_SERVICE_IDENTITY=PASS
test -f "$BASE" && test ! -L "$BASE"
test -f "$BASE_REPORT" && test ! -L "$BASE_REPORT"
python3 - "$BASE" "$BASE_REPORT" <<'PY'
import hashlib,json,sys
path,receipt=sys.argv[1:]
r=json.load(open(receipt))
assert r['status']=='PASS' and r['guest_agent'] is True and r['clean_shutdown'] is True
h=hashlib.sha256()
with open(path,'rb') as f:
 for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
assert r['prepared_image_sha256']==h.hexdigest()
print('VERIFIED_PREPARED_QGA_BASE=PASS')
PY
test "$(timeout 12s virsh -c "$URI" list --all --name | grep -c . || true)" -eq 0 || { echo BLOCKED=EXISTING_DOMAINS;exit 3; }
echo EXISTING_DOMAINS=0
NETINFO="$(mktemp /tmp/kmj-n2-netcheck.XXXXXXXX)"
trap 'rm -f "$NETINFO"' EXIT
timeout 12s virsh -c "$URI" net-info default >"$NETINFO"
python3 - "$NETINFO" <<'PY'
from pathlib import Path
import sys
d={}
for line in Path(sys.argv[1]).read_text().splitlines():
 if ':' in line:
  k,v=line.split(':',1);d[k.strip().lower()]=v.strip().lower()
assert d.get('name')=='default' and d.get('active')=='yes' and d.get('bridge')=='virbr0'
print('LIBVIRT_DEFAULT_NAT=ACTIVE_VERIFIED')
PY
python3 - "$OLD_REPORT" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])
assert p.is_file() and not p.is_symlink()
j=json.loads(p.read_text())
assert j['status']=='FAIL' and j['failure_code']=='LIBVIRT_CREATE_FAILED:LIBVIRT_PROVISION_FAILED'
print('PRIOR_FAILED_REPORT_PRESERVED=PASS')
PY
for path in "$TEST" "$VM_DIR"; do
 test -d "$path" && test ! -L "$path" || { echo BLOCKED=UNSAFE_TEST_DIR;exit 4; }
 test "$(stat -c '%u:%g' "$path")" = 0:0 || { echo BLOCKED=DIR_NOT_ROOT_OWNED;exit 4; }
 mode="$(stat -c '%a' "$path")"
 case "$mode" in 700|711) ;; *) echo BLOCKED=UNEXPECTED_TEST_DIR_MODE;exit 4;; esac
done
if find "$VM_DIR" -maxdepth 1 -name '*.qcow2' -print -quit | grep -q .; then
 echo BLOCKED=EXISTING_OVERLAY_REQUIRES_REVIEW
 exit 4
fi
python3 - "$SRC" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1])
files={
'src/hypervisor/runtime/provider.py':'1fb38a1676cb1369a17e45ec689a85317718fd53',
'src/hypervisor/runtime/libvirt_provider.py':'971e6e6eccc8aef80824abf8b938019a199499c5',
'scripts/ci_libvirt_provider_smoke.py':'e48d474358dc1c489b0c9d19861877634d74b42d',
'scripts/ci_libvirt_lifecycle_checks.py':'f7cce02f079228b8b64fafcaa3533a859102edda'
}
for name,expected in files.items():
 p=root/name
 if not p.is_file() or p.is_symlink():raise RuntimeError('PRIVATE_SOURCE_PATH_INVALID')
 raw=p.read_bytes()
 got=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
 if got!=expected:raise RuntimeError('PRIVATE_SOURCE_BLOB_MISMATCH')
print('PRIVATE_CLOUDOS_FOUR_BLOBS=PASS')
PY
if ! runuser -u libvirt-qemu -- test -r "$BASE"; then echo BLOCKED=QEMU_CANNOT_READ_BASE;exit 4;fi
echo ORIGINAL_PATH_TRAVERSE_BEGIN
for path in "$TEST" "$VM_DIR"; do
 if runuser -u libvirt-qemu -- test -x "$path"; then
  echo "PATH_PREVIOUSLY_ACCESSIBLE=$path"
 else
  echo "PATH_PREVIOUSLY_DENIED=$path"
 fi
done
echo ORIGINAL_PATH_TRAVERSE_END
# No read, write, ownership or execute permission on the files themselves changes.
chmod 0711 -- "$TEST" "$VM_DIR"
for path in "$TEST" "$VM_DIR"; do
 test "$(stat -c '%a' "$path")" = 711
 runuser -u libvirt-qemu -- test -x "$path"
done
echo ONLY_TEST_DIRECTORY_TRAVERSE_REPAIRED=PASS
test ! -e "$TEST/evidence/permission-fix-v2" || { echo BLOCKED=RETRY_EVIDENCE_EXISTS;exit 4; }
install -d -m 0700 "$TEST/evidence/permission-fix-v2"
echo ACTION=RUN_EXACT_PRIVATE_CLOUDOS_PROVIDER_SMOKE_V2
set +e
PYTHONPATH="$SRC" timeout --signal=TERM --kill-after=30s 570s \
 python3 -u "$SRC/scripts/ci_libvirt_provider_smoke.py" \
 --base "$BASE" \
 --storage-dir "$VM_DIR" \
 --output "$NEW_REPORT" \
 --request-key n2-provider-20261031-permissionfix-v2 \
 --require-guest-agent --guest-agent-timeout-seconds 240
RC="$?"
set -e
echo "PROVIDER_SMOKE_EXIT_CODE=$RC"
if [ -f "$NEW_REPORT" ] && [ ! -L "$NEW_REPORT" ]; then
 python3 - "$NEW_REPORT" <<'PY'
import json,sys
j=json.load(open(sys.argv[1]))
print('PROVIDER_STATUS='+str(j.get('status')))
print('PROVIDER_GUEST_AGENT_READY='+str(j.get('guest_agent_ready')))
for key,val in sorted(j.get('checks',{}).items()):
 print('CHECK_'+key.upper()+'='+str(val))
if j.get('failure_code'):print('FAILURE_CODE='+str(j['failure_code'])[:180])
print('RELEASE_GATE_CREDIT='+str(j.get('release_gate_credit')))
PY
else echo PROVIDER_REPORT=NOT_WRITTEN;fi
final="$(timeout 12s virsh -c "$URI" list --all --name | grep -c . || true)"
echo "FINAL_DOMAINS=$final"
echo "REPORT_PATH=$NEW_REPORT"
if [ "$RC" -eq 0 ] && [ "$final" -eq 0 ]; then
 echo RESULT=REAL_CLOUDOS_LIBVIRT_PROVIDER_QGA_LIFECYCLE_PASS
 echo RECEIPT_COMPLETE=YES
else
 echo RESULT=PROVIDER_PERMISSION_RETRY_FAILED_REQUIRES_DIAGNOSTIC
 exit 7
fi
