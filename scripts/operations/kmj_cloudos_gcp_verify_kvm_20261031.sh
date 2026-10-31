#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
OUT="$HOME/kmj_cloudos_kvm_verify_20261031.txt"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
verify() {
  echo "KMJ_CLOUDOS_GCE_KVM_VERIFY_V1"
  echo "SCOPE=READ_ONLY"
  echo "TARGET=$PROJECT/$ZONE/$VM"
  if [ -f "$HOME/kmj_cloudos_kvm_setup_20261031.log" ]; then
    echo "PREVIOUS_SETUP_LOG=FOUND"
    grep -E '^(ACTION=|TARGET=|NESTED_GCE_FLAG=|BLOCKED=|ERROR:)' "$HOME/kmj_cloudos_kvm_setup_20261031.log" | tail -n 12 || true
  else echo "PREVIOUS_SETUP_LOG=MISSING"; fi
  if ! gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format=json > "$TMP/instance.json" 2>"$TMP/error"; then
    echo "GCE_STATUS=ERROR"
    tail -n 3 "$TMP/error" | cut -c1-160
    echo "FINAL=UNVERIFIED"
    return 0
  fi
  python3 - "$TMP/instance.json" > "$TMP/values" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
print('GCE_NAME='+x.get('name','UNKNOWN'))
print('GCE_ZONE='+x.get('zone','').rsplit('/',1)[-1])
print('GCE_STATUS='+x.get('status','UNKNOWN'))
print('GCE_MACHINE='+x.get('machineType','').rsplit('/',1)[-1])
print('GCE_NESTED='+str(x.get('advancedMachineFeatures',{}).get('enableNestedVirtualization',False)).upper())
PY
  cat "$TMP/values"
  if ! grep -qx 'GCE_NESTED=TRUE' "$TMP/values" || ! grep -qx 'GCE_STATUS=RUNNING' "$TMP/values"; then
    echo "FINAL=GCE_NOT_READY"
    return 0
  fi
  if timeout 45s gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --quiet \
      --ssh-flag='-oBatchMode=yes' --ssh-flag='-oConnectTimeout=15' \
      --command="bash -lc 'echo CPU_VMX_COUNT=\$(grep -cw vmx /proc/cpuinfo || true); if test -c /dev/kvm; then echo KVM_DEVICE=YES; else echo KVM_DEVICE=NO; fi; command -v virsh >/dev/null && echo VIRSH=YES || echo VIRSH=NO; command -v qemu-system-x86_64 >/dev/null && echo QEMU=YES || echo QEMU=NO'" \
      >"$TMP/ssh.out" 2>"$TMP/ssh.err"; then
    echo "GUEST_PROBE=PASS"
    grep -E '^(CPU_VMX_COUNT|KVM_DEVICE|VIRSH|QEMU)=' "$TMP/ssh.out" | tail -n 8 || true
    if grep -qx 'KVM_DEVICE=YES' "$TMP/ssh.out" && grep -Eq '^CPU_VMX_COUNT=[1-9][0-9]*$' "$TMP/ssh.out"; then
      echo "FINAL=KVM_EXPOSED_LIFECYCLE_UNTESTED"
    else echo "FINAL=GUEST_KVM_NOT_YET_READY"; fi
  else
    echo "GUEST_PROBE=UNAVAILABLE"
    grep -E 'ERROR|Permission denied|timed out|failed' "$TMP/ssh.err" | tail -n 3 | cut -c1-160 || true
    echo "FINAL=GCE_NESTED_ONLY_GUEST_UNVERIFIED"
  fi
  echo "RECEIPT_COMPLETE=YES"
}
verify | tee "$OUT"
echo "RECEIPT_PATH=$OUT"