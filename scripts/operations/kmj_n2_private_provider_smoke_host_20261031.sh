#!/usr/bin/env bash
# Dedicated N2 test node only. Private CloudOS source stays inside owner GCE VM.
set -Eeuo pipefail
umask 077
ACTION="$1"
ROOT=/home/info_kmjtechno_com
STAGED="$ROOT/kmj_n2_cloudos_provider_20261031"
PACKAGE="$ROOT/kmj_n2_python_defusedxml_20261031.deb"
ARCHIVE="$ROOT/kmj_n2_cloudos_provider_private_20261031.tar"
BASE=/var/lib/libvirt/images/kmj-cloudos-ci/qga-prepared.qcow2
BASE_REPORT=/var/lib/libvirt/images/kmj-cloudos-ci/guest-qga-offline-20261031-v1/report.json
TESTROOT=/var/lib/libvirt/images/kmj-cloudos-ci/provider-smoke-20261031-v1
case "$ACTION" in plan|install|run) ;; *) echo "INVALID_ACTION"; exit 2;; esac
test "$(hostname -s)" = kmj-cloudos-kvm-test
test "$(id -u)" -eq 0
test "$(dpkg --print-architecture)" = amd64
test -c /dev/kvm
echo KMJ_N2_PRIVATE_CLOUDOS_PROVIDER_SMOKE_HELPER_V1
echo "ACTION=$ACTION"
echo SCOPE=EXISTING_N2_AUTHENTICATED_PRIVATE_SOURCE_ONLY
if [ "$ACTION" = plan ] || [ "$ACTION" = install ]; then
 if python3 -c 'import defusedxml' >/dev/null 2>&1; then
  echo PYTHON_DEFUSEDXML=ALREADY_AVAILABLE
  echo RUNTIME_DEPS=PASS
  exit 0
 fi
 python3 - <<'PY'
import re,subprocess
s=subprocess.run(['apt-cache','show','python3-defusedxml'],capture_output=True,text=True,check=True,timeout=14).stdout
for block in s.split('\n\n'):
 f={}
 for line in block.splitlines():
  if ': ' in line and not line.startswith(' '):
   k,v=line.split(': ',1);f[k]=v
 if f.get('Package')!='python3-defusedxml' or f.get('Architecture') not in ('all','amd64'):continue
 path=f.get('Filename','');sha=f.get('SHA256','');version=f.get('Version','')
 if re.fullmatch(r'pool/[A-Za-z0-9_+./%-]+[.]deb',path) and '..' not in path and re.fullmatch('[a-f0-9]{64}',sha):
  print('APT_PACKAGE=python3-defusedxml')
  print('APT_VERSION='+version)
  print('APT_ARCH='+f['Architecture'])
  print('APT_SHA256='+sha)
  print('APT_PATH='+path)
  print('APT_METADATA=PASS')
  break
else:raise RuntimeError('DEFUSEDXML_APT_METADATA_MISSING')
PY
 if [ "$ACTION" = plan ]; then
  echo RESULT=DEFUSEDXML_APT_PLAN_READY
  exit 0
 fi
 test -f "$PACKAGE" && test ! -L "$PACKAGE"
 HASH="$(python3 - <<'PY'
import re,subprocess
s=subprocess.check_output(['apt-cache','show','python3-defusedxml'],text=True)
for block in s.split('\n\n'):
 f={}
 for line in block.splitlines():
  if ': ' in line and not line.startswith(' '):
   k,v=line.split(': ',1);f[k]=v
 if f.get('Package')=='python3-defusedxml' and f.get('Architecture') in ('all','amd64') and re.fullmatch('[0-9a-f]{64}',f.get('SHA256','')):
  print(f['SHA256']);break
PY
)"
 echo "$HASH  $PACKAGE" | sha256sum -c -
 test "$(dpkg-deb -f "$PACKAGE" Package)" = python3-defusedxml
 LOG="$(mktemp /tmp/kmj-defused-install.XXXXXXXX)"
 if timeout --signal=TERM --kill-after=5s 80s dpkg -i "$PACKAGE" >"$LOG" 2>&1; then
  echo OFFLINE_DEFUSEDXML_DPKG=PASS
 else
  echo OFFLINE_DEFUSEDXML_DPKG=FAIL
  tail -n 8 "$LOG" | cut -c1-150
  rm -f "$LOG"
  exit 5
 fi
 rm -f "$LOG"
 python3 -c 'import defusedxml'
 echo RUNTIME_DEPS=PASS
 exit 0
fi
python3 -c 'import defusedxml' || { echo MISSING_DEFUSEDXML; exit 6; }
command -v qemu-img >/dev/null
command -v virsh >/dev/null
test -f "$ARCHIVE" && test ! -L "$ARCHIVE"
EXPECTED_SHA="$2"
[[ "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ ]]
echo "$EXPECTED_SHA  $ARCHIVE" | sha256sum -c -
count="$(timeout 10s virsh -c qemu:///system list --all --name | grep -c . || true)"
echo "PREEXISTING_DOMAINS=$count"
test "$count" -eq 0 || { echo BLOCKED=OTHER_DOMAINS_PRESENT; exit 7; }
timeout 10s virsh -c qemu:///system net-info default | grep -Eq '^Active:[[:space:]]*yes' || { echo BLOCKED=LIBVIRT_NET; exit 7; }
test -f "$BASE" && test ! -L "$BASE"
test -f "$BASE_REPORT" && test ! -L "$BASE_REPORT"
python3 - "$BASE" "$BASE_REPORT" <<'PY'
import hashlib,json,sys
base,report=sys.argv[1:]
r=json.load(open(report))
assert r['status']=='PASS' and r['guest_agent'] is True and r['clean_shutdown'] is True
assert r['guest_ip'] and r['prepared_image_sha256']
h=hashlib.sha256()
with open(base,'rb') as f:
 for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
assert h.hexdigest()==r['prepared_image_sha256']
print('PREPARED_IMAGE_OWNER_RECEIPT_AND_HASH=PASS')
PY
python3 - "$BASE" <<'PY'
import json,subprocess,sys
x=json.loads(subprocess.check_output(['qemu-img','info','--output=json','-f','qcow2',sys.argv[1]],text=True,timeout=15))
assert x.get('format')=='qcow2' and not x.get('backing-filename')
print('PREPARED_IMAGE_STANDALONE_QCOW2=PASS')
PY
test ! -e "$TESTROOT" && test ! -L "$TESTROOT" || { echo BLOCKED=TEST_DIR_ALREADY_PRESENT; exit 7; }
test "$(df -PB1 /var/lib/libvirt/images | awk 'NR==2{print $4}')" -gt 6500000000 || { echo BLOCKED=INSUFFICIENT_DISK; exit 7; }
install -d -m 0700 "$TESTROOT"
python3 - "$ARCHIVE" "$TESTROOT" <<'PY'
import hashlib,pathlib,sys,tarfile
archive=pathlib.Path(sys.argv[1]);root=pathlib.Path(sys.argv[2])
expected={
'src/hypervisor/runtime/provider.py':'1fb38a1676cb1369a17e45ec689a85317718fd53',
'src/hypervisor/runtime/libvirt_provider.py':'971e6e6eccc8aef80824abf8b938019a199499c5',
'scripts/ci_libvirt_provider_smoke.py':'e48d474358dc1c489b0c9d19861877634d74b42d',
'scripts/ci_libvirt_lifecycle_checks.py':'f7cce02f079228b8b64fafcaa3533a859102edda',
}
seen=set()
with tarfile.open(archive,'r:') as tar:
 for m in tar.getmembers():
  if m.isdir(): continue
  if not m.isfile() or m.name not in expected or m.name in seen or m.size>128000:
   raise ValueError('PRIVATE_SOURCE_ARCHIVE_UNEXPECTED_ENTRY')
  raw=tar.extractfile(m).read()
  blob=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
  if blob!=expected[m.name]:raise ValueError('PRIVATE_SOURCE_GIT_BLOB_MISMATCH')
  path=root/m.name
  path.parent.mkdir(parents=True,exist_ok=True)
  path.write_bytes(raw)
  path.chmod(0o600)
  seen.add(m.name)
assert seen==set(expected),'REQUIRED_SOURCE_MISSING'
print('PRIVATE_SOURCE_FOUR_GIT_BLOBS=PASS')
PY
install -d -m 0700 "$TESTROOT/vms"
install -d -m 0700 "$TESTROOT/evidence"
echo ACTION=RUN_REAL_CLOUDOS_LIBVIRT_PROVIDER
set +e
PYTHONPATH="$TESTROOT" timeout --signal=TERM --kill-after=25s 570s \
 python3 -u "$TESTROOT/scripts/ci_libvirt_provider_smoke.py" \
 --base "$BASE" --storage-dir "$TESTROOT/vms" \
 --output "$TESTROOT/evidence/provider-report.json" \
 --request-key n2-provider-20261031-fixed1 \
 --require-guest-agent --guest-agent-timeout-seconds 240
RC="$?"
set -e
echo "PROVIDER_SMOKE_EXIT_CODE=$RC"
if [ -f "$TESTROOT/evidence/provider-report.json" ]; then
 python3 - "$TESTROOT/evidence/provider-report.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
print('PROVIDER_STATUS='+str(r.get('status','UNKNOWN')))
print('PROVIDER_GUEST_AGENT_READY='+str(r.get('guest_agent_ready',False)))
for k,v in sorted(r.get('checks',{}).items()):
 print('CHECK_'+k.upper()+'='+str(v))
if 'failure_code' in r:print('FAILURE_CODE='+str(r['failure_code'])[:160])
print('RELEASE_GATE_CREDIT='+str(r.get('release_gate_credit')))
PY
else echo PROVIDER_REPORT=MISSING; fi
final="$(timeout 10s virsh -c qemu:///system list --all --name | grep -c . || true)"
echo "FINAL_DOMAINS=$final"
echo "REPORT_PATH=$TESTROOT/evidence/provider-report.json"
if [ "$RC" -eq 0 ] && [ "$final" -eq 0 ]; then
 echo RESULT=REAL_CLOUDOS_LIBVIRT_PROVIDER_SMOKE_PASS
else
 echo RESULT=PROVIDER_SMOKE_FAILED_REQUIRES_REVIEW
 exit 8
fi
echo RECEIPT_COMPLETE=YES
