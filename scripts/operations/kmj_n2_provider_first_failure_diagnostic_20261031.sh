#!/usr/bin/env bash
# Dedicated N2 real-provider first failure: READ-ONLY forensics.
# No chmod/chown, no VM creation, no production or GCE changes.
set -Eeuo pipefail
umask 077
ROOT=/var/lib/libvirt/images/kmj-cloudos-ci
TEST="$ROOT/provider-smoke-20261031-v1"
BASE="$ROOT/qga-prepared.qcow2"
REPORT="$TEST/evidence/provider-report.json"
RECEIPT=/var/tmp/kmj_n2_provider_failure_diagnostic_20261031.txt
test "$(hostname -s)" = kmj-cloudos-kvm-test
test "$(id -u)" = 0
exec > >(tee "$RECEIPT") 2>&1
echo KMJ_CLOUDOS_N2_PROVIDER_FAILURE_DIAGNOSTIC_V1
echo SCOPE=READ_ONLY_ONE_N2_HOST
echo HOST_IDENTITY=PASS
N="$(timeout 12s virsh -c qemu:///system list --all --name | grep -c . || true)"
echo "DEFINED_DOMAINS=$N"
if [ "$N" -gt 0 ]; then echo NOTE=EXISTING_DOMAINS_PRESERVED; fi
python3 - "$REPORT" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])
if not p.is_file() or p.is_symlink():
 print('PROVIDER_REPORT=UNAVAILABLE')
else:
 j=json.loads(p.read_text())
 for k in ('status','failure_code','first_result_state','cleanup_retry','release_gate_credit','guest_agent_ready'):
  print('PROVIDER_'+k.upper()+'='+str(j.get(k,'NOT_RECORDED'))[:150])
 print('PROVIDER_CHECK_COUNT='+str(len(j.get('checks',{}))))
PY
echo "LIBVIRT_QEMU_SERVICE_IDENTITY_BEGIN"
if getent passwd libvirt-qemu >/dev/null; then
 getent passwd libvirt-qemu | cut -d: -f1,3,4,7
else
 echo LIBVIRT_QEMU_USER=NOT_PRESENT
fi
echo "LIBVIRT_QEMU_SERVICE_IDENTITY_END"
python3 - "$TEST" "$TEST/vms" "$TEST/evidence" "$BASE" <<'PY'
import os,stat,sys
for label,p in zip(('TEST_ROOT','TEST_VM_STORAGE','TEST_EVIDENCE','PREPARED_BASE'),sys.argv[1:]):
 try:
  s=os.lstat(p)
  print(label+'_MODE='+oct(stat.S_IMODE(s.st_mode)))
  print(label+'_UID='+str(s.st_uid))
  print(label+'_GID='+str(s.st_gid))
  print(label+'_IS_SYMLINK='+str(stat.S_ISLNK(s.st_mode)))
 except OSError as exc:
  print(label+'_STAT='+type(exc).__name__)
PY
if command -v namei >/dev/null; then
 echo DISK_PARENT_CHAIN_BEGIN
 namei -l "$TEST/vms" 2>&1 | cut -c1-200 | tail -n 14 || true
 echo DISK_PARENT_CHAIN_END
fi
if command -v runuser >/dev/null && getent passwd libvirt-qemu >/dev/null; then
 for dir in "$ROOT" "$TEST" "$TEST/vms"; do
  key=ROOT
  case "$dir" in "$TEST") key=TEST;; "$TEST/vms")key=VMS;; esac
  if runuser -u libvirt-qemu -- test -x "$dir"; then
   echo "QEMU_TRAVERSE_$key=PASS"
  else
   echo "QEMU_TRAVERSE_$key=DENIED"
  fi
 done
 if runuser -u libvirt-qemu -- test -r "$BASE"; then
  echo QEMU_READ_PREPARED_BASE=PASS
 else
  echo QEMU_READ_PREPARED_BASE=DENIED
 fi
fi
echo "LIBVIRT_LOG_EVIDENCE_BEGIN"
if command -v journalctl >/dev/null; then
 timeout 15s journalctl -u libvirtd -u virtqemud -u virtlogd \
  --since '-90 minutes' --no-pager -n 450 -o cat 2>/dev/null \
 | grep -Ei 'denied|permission|error|failed|qemu|nvram|firmware|security|apparmor' \
 | tail -n 26 | cut -c1-200 \
 | sed -E 's/(token|password|secret|authorization):[^ ,]*/\1:[REDACTED]/Ig' || true
fi
echo LIBVIRT_LOG_EVIDENCE_END
echo QEMU_DOMAIN_LOG_EVIDENCE_BEGIN
if [ -d /var/log/libvirt/qemu ] && [ ! -L /var/log/libvirt/qemu ]; then
 python3 - <<'PY'
from pathlib import Path
p=Path('/var/log/libvirt/qemu')
files=sorted((f for f in p.glob('kmj-ci-kmj-validation-*.log') if f.is_file() and not f.is_symlink()),key=lambda x:x.stat().st_mtime,reverse=True)
if not files:
 print('MATCHING_TEST_DOMAIN_LOGS=NONE')
else:
 for f in files[:2]:
  print('TEST_DOMAIN_LOG='+f.name)
  for line in f.read_text(errors='replace').splitlines()[-18:]:
   if any(t in line.lower() for t in ('error','denied','failed','nvram','permission','firmware','qemu-system')):
    print(line[:200])
PY
else echo LIBVIRT_QEMU_LOG_DIR=UNAVAILABLE
fi
echo QEMU_DOMAIN_LOG_EVIDENCE_END
echo RESULT=READ_ONLY_PROVIDER_FAILURE_DIAGNOSTIC_COMPLETE
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$RECEIPT"
