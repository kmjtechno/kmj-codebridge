#!/usr/bin/env bash
# Read-only CloudOS GCE health + transient-guest inventory.
# This script always returns normally and never restarts or edits anything.
set -u
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
OUT="$HOME/kmj_cloudos_after_crash_v2_20261031.txt"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
{
  echo "CLOUDOS_AFTER_CRASH_V2"
  echo "SCOPE=READ_ONLY_NO_MODIFICATIONS"
  echo "VM=$PROJECT/$ZONE/$VM"
  if timeout 30s gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format=json >"$TMP/instance.json" 2>"$TMP/gce.err"; then
    echo "GCE_READ=PASS"
    python3 - "$TMP/instance.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
print('GCE_STATUS='+x.get('status','UNKNOWN'))
print('GCE_MACHINE='+x.get('machineType','').rsplit('/',1)[-1])
print('GCE_NESTED='+str(x.get('advancedMachineFeatures',{}).get('enableNestedVirtualization',False)).upper())
PY
    state="$(python3 - "$TMP/instance.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1])).get('status','UNKNOWN'))
PY
)"
    if [ "$state" = RUNNING ]; then
      if timeout --signal=TERM --kill-after=5s 50s gcloud compute ssh "$VM" \
        --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
        --ssh-flag='-oBatchMode=yes' --ssh-flag='-oConnectTimeout=12' \
        --command="bash -lc 'echo GUEST_SSH=CONNECTED; if test -c /dev/kvm; then echo KVM_DEVICE=PRESENT; else echo KVM_DEVICE=ABSENT; fi; grep MemAvailable /proc/meminfo; echo LIBVIRT_SERVICE_STATE_BEGIN; systemctl is-active libvirtd || true; echo LIBVIRT_SERVICE_STATE_END; echo LIBVIRT_DOMAINS_BEGIN; timeout 8s sudo -n virsh -c qemu:///system list --all --name 2>/dev/null || echo LIBVIRT_DOMAIN_LIST=UNAVAILABLE; echo LIBVIRT_DOMAINS_END; echo GUEST_PROBE_COMPLETE=YES'" \
        >"$TMP/guest.out" 2>"$TMP/guest.err"; then
        echo "GUEST_PROBE=PASS"
        grep -E '^(GUEST_SSH|KVM_DEVICE|MemAvailable|LIBVIRT_|GUEST_PROBE_COMPLETE|kmj-cloudos-smoke-)' "$TMP/guest.out" | tail -n 25 || true
      else
        echo "GUEST_PROBE=SSH_FAILED_OR_TIMEOUT"
        grep -Ei 'error|denied|refused|timed out|failed|4003' "$TMP/guest.err" | tail -n 3 | cut -c1-160 || true
      fi
    else
      echo "GUEST_PROBE=SKIPPED_NOT_RUNNING"
    fi
  else
    echo "GCE_READ=FAILED_OR_TIMEOUT"
    grep -Ei 'error|denied|timeout' "$TMP/gce.err" | tail -n 3 | cut -c1-160 || true
  fi
  echo "RECEIPT_COMPLETE=YES"
} 2>&1 | tee "$OUT"
echo "RECEIPT_PATH=$OUT"
exit 0
