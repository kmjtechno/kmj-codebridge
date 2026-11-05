#!/usr/bin/env bash
# Generic, owner-initiated Google Cloud Shell KVM host audit.
# START is billable. This never creates/deletes guest VMs or disks.
set -Eeuo pipefail

if (( $# != 3 )); then
  echo 'USAGE: bash script.sh PROJECT ZONE INSTANCE' >&2
  exit 64
fi
PROJECT="$1"; ZONE="$2"; VM="$3"
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ ]] || { echo 'INVALID_PROJECT' >&2; exit 64; }
[[ "$ZONE" =~ ^[a-z]+-[a-z0-9]+[0-9]-[a-z]$ ]] || { echo 'INVALID_ZONE' >&2; exit 64; }
[[ "$VM" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || { echo 'INVALID_VM' >&2; exit 64; }
command -v gcloud >/dev/null || { echo 'GCLOUD_REQUIRED' >&2; exit 69; }
command -v timeout >/dev/null || { echo 'TIMEOUT_REQUIRED' >&2; exit 69; }

ARMED=0
stop_n2() {
  trap - EXIT HUP INT TERM
  if [[ "$ARMED" == 1 ]]; then
    echo 'VM_STOP=REQUESTING'
    timeout 180 gcloud compute instances stop "$VM" \
      --project="$PROJECT" --zone="$ZONE" --quiet || echo 'VM_STOP=RETRY_REQUIRED'
    local state
    state=$(timeout 25 gcloud compute instances describe "$VM" \
      --project="$PROJECT" --zone="$ZONE" --format='value(status)' --quiet 2>/dev/null || true)
    echo "VM_FINAL_STATE=$state"
    if [[ "$state" != TERMINATED ]]; then
      echo 'VM_STOP=NOT_CONFIRMED'
      echo "EMERGENCY_STOP: gcloud compute instances stop $VM --project=$PROJECT --zone=$ZONE --quiet"
      echo 'SERVER_SIDE_AUTO_STOP=900_SECONDS'
    fi
  fi
}
trap stop_n2 EXIT
trap 'exit 130' HUP INT TERM

state=$(timeout 35 gcloud compute instances describe "$VM" \
  --project="$PROJECT" --zone="$ZONE" --format='value(status)' --quiet)
[[ "$state" == TERMINATED ]] || { echo "REFUSE_START: VM_$state" >&2; exit 1; }
echo 'VM_PRECHECK=TERMINATED'

# This GCE API operation is only available while the instance is stopped.
# Confirm the control-plane stop guard before starting billable compute.
timeout 80 gcloud compute instances set-scheduling "$VM" \
  --project="$PROJECT" --zone="$ZONE" \
  --max-run-duration=15m --instance-termination-action=STOP --quiet
maxsec=$(timeout 35 gcloud compute instances describe "$VM" \
  --project="$PROJECT" --zone="$ZONE" \
  --format='value(scheduling.maxRunDuration.seconds)' --quiet)
action=$(timeout 35 gcloud compute instances describe "$VM" \
  --project="$PROJECT" --zone="$ZONE" \
  --format='value(scheduling.instanceTerminationAction)' --quiet)
[[ "$maxsec" == 900 && "$action" == STOP ]] || {
  echo "REFUSE_START: AUTO_STOP_UNVERIFIED($maxsec,$action)" >&2
  exit 2
}
echo 'SERVER_SIDE_AUTO_STOP=900_SECONDS_VERIFIED'
ARMED=1

# ARMED is set before the start request: even on a timeout, EXIT attempts stop.
timeout 120 gcloud compute instances start "$VM" \
  --project="$PROJECT" --zone="$ZONE" --quiet
state=$(timeout 35 gcloud compute instances describe "$VM" \
  --project="$PROJECT" --zone="$ZONE" --format='value(status)' --quiet)
[[ "$state" == RUNNING ]] || { echo "VM_START_NOT_VERIFIED=$state" >&2; exit 3; }
echo 'VM_RUNNING=VERIFIED'

REMOTE=$(cat <<'REMOTE_SCRIPT'
set -u
echo "HOST=$(hostname)"
if test -c /dev/kvm; then echo 'KVM_DEVICE=PRESENT'; else echo 'KVM_DEVICE=ABSENT'; fi
if ! command -v virsh >/dev/null 2>&1; then echo 'LIBVIRT_CLI=ABSENT'; exit 20; fi
echo '=== EXISTING LIBVIRT DOMAINS ==='
virsh -c qemu:///system list --all || exit 21
echo '=== EXISTING LIBVIRT NETWORKS ==='
virsh -c qemu:///system net-list --all || exit 22
echo '=== TENANT NETWORK DHCP LEASES ==='
for net in $(virsh -c qemu:///system net-list --all --name); do
  case "$net" in
    kmjtn-*) echo "TENANT_NETWORK=$net"; virsh -c qemu:///system net-dhcp-leases "$net" || echo "LEASE_QUERY_FAILED=$net" ;;
  esac
done
echo '=== EXISTING DOMAIN INTERFACES AND DISKS ==='
for domain in $(virsh -c qemu:///system list --all --name); do
  echo "DOMAIN=$domain"
  virsh -c qemu:///system domiflist "$domain" || echo "DOMAIN_INTERFACES_FAILED=$domain"
  virsh -c qemu:///system domblklist "$domain" || echo "DOMAIN_DISKS_FAILED=$domain"
done
echo 'HOST_AUDIT=READ_ONLY_COMPLETE'
REMOTE_SCRIPT
)
set +e
timeout 300 gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" \
  --tunnel-through-iap --quiet --command="$REMOTE"
rc=$?
set -e
echo "SSH_AUDIT_EXIT=$rc"
echo 'HOST_AUDIT_END_REQUEST_STOP'
# EXIT trap immediately issues STOP, then checks the final VM state.
