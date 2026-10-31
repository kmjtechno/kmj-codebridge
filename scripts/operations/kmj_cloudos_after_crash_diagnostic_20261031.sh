#!/usr/bin/env bash
# KMJ CloudOS: read-only check after interrupted lifecycle test.
# No reboot, VM creation/deletion, firewall, guest or disk modification.
set -u
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
OUT="$HOME/kmj_cloudos_after_crash_20261031.txt"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
{
  echo "KMJ_CLOUDOS_AFTER_CRASH_DIAGNOSTIC_V1"
  echo "SCOPE=READ_ONLY_NO_CHANGES"
  echo "TARGET=$PROJECT/$ZONE/$VM"
  if ! timeout 30s gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format=json >"$TMP/gce.json" 2>"$TMP/gce.err"; then
    echo "GCE_DESCRIBE=FAILED_OR_TIMEOUT"
    grep -Ei 'error|denied|timeout' "$TMP/gce.err" | tail -n 3 | cut -c 1-160 || true
    echo "COMPLETE=YES"
  else
    echo "GCE_DESCRIBE=PASS"
    python3 - "$TMP/gce.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
print("GCE_VM="+x.get("name","UNKNOWN"))
print("GCE_STATUS="+x.get("status","UNKNOWN"))
print("GCE_MACHINE="+x.get("machineType","").rsplit("/",1)[-1])
print("GCE_NESTED="+str(x.get("advancedMachineFeatures",{}).get("enableNestedVirtualization",False)).upper())
PY
    state="$(python3 - "$TMP/gce.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1])).get("status","UNKNOWN"))
PY
)"
    if [ "$state" = "RUNNING" ]; then
      echo "GUEST_READ_ONLY_SSH=START"
      if timeout --signal=TERM --kill-after=5s 50s gcloud compute ssh "$VM" \
        --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
        --ssh-flag='-oBatchMode=yes' --ssh-flag='-oConnectTimeout=12' \
        --command="bash -lc 'echo GUEST_CONNECTED=YES; echo GUEST_UPTIME_SEC=\$(cut -d. -f1 /proc/uptime | cut -d\\  -f1); echo KVM_PRESENT=\$(test -c /dev/kvm && echo YES || echo NO); echo MEM_AVAILABLE_KIB=\$(awk \"/MemAvailable:/ {print \\\$2}\" /proc/meminfo); echo LIBVIRT=\$(systemctl is-active libvirtd 2>/dev/null || true); echo QEMU_PROCESSES=\$(pgrep -fc qemu-system-x86_64 || true); echo LIBVIRT_DOMAINS_BEGIN; timeout 8s sudo -n virsh -c qemu:///system list --all --name 2>/dev/null || echo LIBVIRT_LIST=UNAVAILABLE; echo LIBVIRT_DOMAINS_END; echo GUEST_READ_ONLY_DONE=YES'" \
        >"$TMP/ssh.out" 2>"$TMP/ssh.err"; then
        echo "GUEST_READ_ONLY_SSH=PASS"
        grep -E '^(GUEST_CONNECTED|GUEST_UPTIME_SEC|KVM_PRESENT|MEM_AVAILABLE_KIB|LIBVIRT|QEMU_PROCESSES|LIBVIRT_DOMAINS|LIBVIRT_LIST|GUEST_READ_ONLY_DONE|kmj-cloudos-smoke-)' "$TMP/ssh.out" | tail -n 30 || true
      else
        echo "GUEST_READ_ONLY_SSH=FAILED_OR_TIMEOUT"
        grep -Ei 'error|denied|refused|timed out|failed|4003|exited with' "$TMP/ssh.err" | tail -n 4 | cut -c 1-160 || true
      fi
    else
      echo "GUEST_READ_ONLY_SSH=SKIPPED_NOT_RUNNING"
    fi
    echo "COMPLETE=YES"
  fi
} 2>&1 | tee "$OUT"
echo "RECEIPT_PATH=$OUT"
exit 0
