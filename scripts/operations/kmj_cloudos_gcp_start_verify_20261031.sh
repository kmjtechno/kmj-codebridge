#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
OUT="$HOME/kmj_cloudos_kvm_start_verify_20261031.txt"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

{
  echo "KMJ_CLOUDOS_KVM_START_VERIFY_V1"
  echo "SCOPE=ONLY_EXISTING_KVM_TEST_VM"
  echo "PROJECT=$PROJECT"
  echo "ZONE=$ZONE"
  echo "INSTANCE=$VM"
  echo "BILLING=RUNNING_N2_CONSUMES_GOOGLE_CLOUD_CREDITS"
  if ! gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format=json > "$TMP/instance.json" 2>"$TMP/error"; then
    echo "INSTANCE_READ=FAILED"
    tail -n 4 "$TMP/error" | cut -c1-160
    exit 2
  fi
  python3 - "$TMP/instance.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x.get("name")=="kmj-cloudos-kvm-test", "Unexpected VM name"
assert x.get("zone","").endswith("/us-central1-a"), "Unexpected zone"
assert x.get("machineType","").split("/")[-1].startswith("n2-"), "N2 machine required"
assert x.get("advancedMachineFeatures",{}).get("enableNestedVirtualization") is True, "Nested virtualization not enabled"
assert x.get("status") in ("TERMINATED","RUNNING"), "Unsafe VM state"
assert any(d.get("boot") for d in x.get("disks",[])), "No boot disk"
print("GCE_CONFIG=PASS")
print("MACHINE="+x["machineType"].split("/")[-1])
print("NESTED_FLAG=TRUE")
print("INITIAL_STATE="+x["status"])
PY
  STATUS="$(python3 - "$TMP/instance.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))["status"])
PY
)"
  if [ "$STATUS" = TERMINATED ]; then
    echo "ACTION=START_EXISTING_TEST_VM"
    if gcloud compute instances start "$VM" --project="$PROJECT" --zone="$ZONE" --quiet >"$TMP/start.out" 2>"$TMP/start.err"; then
      echo "START_COMMAND=PASS"
    else
      echo "START_COMMAND=FAILED"
      tail -n 8 "$TMP/start.err" | cut -c1-180
      exit 3
    fi
  else
    echo "ACTION=ALREADY_RUNNING_NO_CHANGE"
  fi
  STATE="$(gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format='value(status)')"
  echo "FINAL_STATE=$STATE"
  if [ "$STATE" != RUNNING ]; then
    echo "RESULT=NOT_RUNNING"
    exit 4
  fi
  echo "GUEST_PROBE=STARTING"
  if timeout 90s gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --quiet --ssh-flag="-oBatchMode=yes" --ssh-flag="-oConnectTimeout=15" --command="bash -lc 'echo GUEST_HOST=CONNECTED; echo CPU_VMX_COUNT=\$(grep -cw vmx /proc/cpuinfo || true); if test -c /dev/kvm; then echo KVM_DEVICE=PRESENT; else echo KVM_DEVICE=ABSENT; fi; if command -v virsh >/dev/null 2>&1; then echo VIRSH=PRESENT; else echo VIRSH=MISSING; fi; if command -v qemu-system-x86_64 >/dev/null 2>&1; then echo QEMU=PRESENT; else echo QEMU=MISSING; fi'" >"$TMP/ssh.out" 2>"$TMP/ssh.err"; then
    echo "GUEST_PROBE=PASS"
    grep -E '^(GUEST_HOST|CPU_VMX_COUNT|KVM_DEVICE|VIRSH|QEMU)=' "$TMP/ssh.out" | tail -n 12 || true
    if grep -qx 'KVM_DEVICE=PRESENT' "$TMP/ssh.out" && grep -Eq '^CPU_VMX_COUNT=[1-9][0-9]*$' "$TMP/ssh.out"; then
      echo "RESULT=KVM_EXPOSED_LIFECYCLE_NOT_YET_VERIFIED"
    else
      echo "RESULT=KVM_GUEST_CONFIGURATION_PENDING"
    fi
  else
    echo "GUEST_PROBE=BLOCKED_SSH"
    grep -Ei 'error|permission denied|timed out|failed' "$TMP/ssh.err" | tail -n 5 | cut -c1-160 || true
    echo "RESULT=RUNNING_BUT_SSH_UNVERIFIED"
  fi
  echo "RECEIPT_COMPLETE=YES"
} 2>&1 | tee "$OUT"
echo "RECEIPT_PATH=$OUT"
