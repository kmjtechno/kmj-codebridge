#!/usr/bin/env bash
# KMJ CloudOS dedicated N2 lab: bounded READ-ONLY tenant network/guest attestation.
# GCE start is billable. The remote section never writes host settings or starts guests.
set -Eeuo pipefail
if (( $# != 3 )); then echo 'USAGE: SCRIPT PROJECT ZONE INSTANCE' >&2; exit 64; fi
PROJECT="$1"; ZONE="$2"; VM="$3"
if [[ "$PROJECT/$ZONE/$VM" != 'kmj-techno/us-central1-a/kmj-cloudos-kvm-test' ]]; then
  echo 'N2_STORAGE_AUDIT=REFUSE_WRONG_INSTANCE'; exit 65
fi
for cmd in timeout gcloud; do command -v "$cmd" >/dev/null || exit 69; done
ARMED=0
stop_n2() {
  trap - EXIT HUP INT TERM
  if [[ "$ARMED" == 1 ]]; then
    echo 'VM_STOP=REQUESTING'
    timeout 180 gcloud compute instances stop "$VM" --project="$PROJECT" \
      --zone="$ZONE" --quiet || echo 'VM_STOP=RETRY_REQUIRED'
    state=$(timeout 35 gcloud compute instances describe "$VM" \
      --project="$PROJECT" --zone="$ZONE" --format='value(status)' --quiet 2>/dev/null || true)
    echo "VM_FINAL_STATE=$state"
    if [[ "$state" != TERMINATED ]]; then
      echo 'N2_STOP_NOT_VERIFIED=MANUAL_STOP_REQUIRED'
    fi
  fi
}
trap stop_n2 EXIT
trap 'exit 130' HUP INT TERM
state=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(status)' --quiet)
if [[ "$state" != TERMINATED ]]; then echo "N2_STORAGE_AUDIT=REFUSE_STATUS_$state"; exit 2; fi
echo 'N2_PRECHECK=TERMINATED'
timeout 80 gcloud compute instances set-scheduling "$VM" --project="$PROJECT" \
 --zone="$ZONE" --max-run-duration=15m --instance-termination-action=STOP --quiet
limit=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(scheduling.maxRunDuration.seconds)' --quiet)
action=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(scheduling.instanceTerminationAction)' --quiet)
if [[ "$limit/$action" != '900/STOP' ]]; then
  echo 'N2_STORAGE_AUDIT=REFUSE_AUTO_STOP_UNVERIFIED'; exit 3
fi
echo 'SERVER_SIDE_AUTO_STOP=900_SECONDS_VERIFIED'
ARMED=1
timeout 120 gcloud compute instances start "$VM" --project="$PROJECT" --zone="$ZONE" --quiet
state=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(status)' --quiet)
if [[ "$state" != RUNNING ]]; then echo "N2_STORAGE_AUDIT=REFUSE_BOOT_$state"; exit 4; fi
echo 'VM_RUNNING=VERIFIED'

ready=0
for attempt in 1 2 3 4 5; do
  echo "IAP_SSH_PROBE_ATTEMPT=$attempt"
  if timeout 30 gcloud compute ssh "$VM" --project="$PROJECT" \
    --zone="$ZONE" --tunnel-through-iap --quiet \
    --command='printf N2_SSH_PROBE_READY=YES' 2>/dev/null |
      grep -q 'N2_SSH_PROBE_READY=YES'; then
    ready=1
    break
  fi
  if [[ "$attempt" -lt 5 ]]; then sleep 15; fi
done
if [[ "$ready" != 1 ]]; then echo 'IAP_SSH_PREFLIGHT=BLOCKED'; exit 71; fi
echo 'IAP_SSH_PREFLIGHT=PASS'
REMOTE=$(cat <<'REMOTE_SCRIPT'
python3 - <<'PY'
import json
import os
from pathlib import Path
import stat
import subprocess
import urllib.request

EXPECTED_HOST = "kmj-cloudos-kvm-test"
EXPECTED_PROJECT = "kmj-techno"
EXPECTED_ZONE = "us-central1-a"
EXPECTED_MACHINE = "n2-standard-2"
OLD_OVERLAYS = (
    "kmj-ci-kmj-validation-26b557dc40dc0d0cf5cf.qcow2",
    "kmj-ci-other-tenant-8fd54398cc6bb3e5658d.qcow2",
)
IMAGE_DIR = Path("/var/lib/libvirt/images/kmj-cloudos-ci/provider-smoke-20261031-v1/vms")

def meta(endpoint):
    req = urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/" + endpoint,
        headers={"Metadata-Flavor": "Google"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=3) as reply:
        if reply.headers.get("Metadata-Flavor") != "Google":
            raise RuntimeError("GCE_METADATA_HEADER_UNVERIFIED")
        return reply.read(300).decode("utf-8").strip()

def safe_stat(path):
    try:
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            return None
        return st
    except OSError:
        return None

def command(*args):
    run = subprocess.run(args, capture_output=True, text=True, timeout=20)
    if run.returncode or len(run.stdout.encode()) > 15000:
        raise RuntimeError("READ_COMMAND_FAILED")
    return run.stdout.strip()

try:
    if (os.geteuid() == 0 or os.uname().nodename.split(".")[0] != EXPECTED_HOST
            or meta("instance/name") != EXPECTED_HOST
            or meta("project/project-id") != EXPECTED_PROJECT
            or not meta("instance/zone").endswith("/" + EXPECTED_ZONE)
            or not meta("instance/machine-type").endswith("/" + EXPECTED_MACHINE)):
        raise RuntimeError("GCE_HOST_IDENTITY_MISMATCH")
    disks = command("virsh", "-c", "qemu:///system", "list", "--all", "--name")
    existing = set(disks.splitlines()) - {""}
    expected = {name.removesuffix(".qcow2") for name in OLD_OVERLAYS}
    if existing != expected:
        raise RuntimeError("LEGACY_DOMAIN_INVENTORY_CHANGED")
    if command("virsh", "-c", "qemu:///system", "list", "--name"):
        raise RuntimeError("GUEST_RUNNING_REFUSE")
    print("N2_IDENTITY_AND_GUEST_INVENTORY=PASS_READ_ONLY")
    root = os.statvfs("/")
    root_size = root.f_blocks * root.f_frsize
    root_used = (root.f_blocks - root.f_bfree) * root.f_frsize
    root_available = root.f_bavail * root.f_frsize
    if not (0 < root_used <= root_size <= 100 * (1024 ** 3)):
        raise RuntimeError("UNEXPECTED_ROOT_FILESYSTEM_SIZE")
    print("N2_ROOT_FILESYSTEM_TOTAL_BYTES=" + str(root_size))
    print("N2_ROOT_FILESYSTEM_USED_BYTES=" + str(root_used))
    print("N2_ROOT_FILESYSTEM_AVAILABLE_BYTES=" + str(root_available))
    for i, filename in enumerate(OLD_OVERLAYS, 1):
        path = IMAGE_DIR / filename
        st = safe_stat(path)
        if st is None or not stat.S_ISDIR(os.lstat(IMAGE_DIR).st_mode):
            print("OLD_GUEST_OVERLAY_" + str(i) + "=UNKNOWN_STAT_UNAVAILABLE")
        else:
            print("OLD_GUEST_OVERLAY_" + str(i) + "_LOGICAL_BYTES=" + str(st.st_size))
            print("OLD_GUEST_OVERLAY_" + str(i) + "_ALLOCATED_BYTES=" + str(st.st_blocks * 512))
    print("EXISTING_GUEST_DOMAINS=2_SHUT_OFF_UNCHANGED")
    print("RAW_DISK_BACKUP_BYTES=AT_LEAST_30GB_UNLESS_COMPRESSED_OR_SPARSE")
    print("BACKUP_COMPRESSED_SIZE=NOT_MEASURED")
    print("OFFSITE_TARGET_CURRENT_CAPACITY=NOT_VERIFIED")
    print("BACKUP_TRANSFER_AND_DISPOSABLE_RESTORE=NOT_ATTEMPTED")
    print("N2_STORAGE_FEASIBILITY_READONLY=PASS")
    print("CLOUDOS_BACKUP_RESTORE_GATE=BLOCKED")
except Exception as exc:
    print("N2_STORAGE_FEASIBILITY_READONLY=BLOCKED")
    print("N2_STORAGE_REASON=" + str(exc)[:180])
    raise SystemExit(2)
PY
REMOTE_SCRIPT
)
set +e
timeout 260 gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" \
 --tunnel-through-iap --quiet --command="$REMOTE"
exit_code=$?
set -e
echo "N2_STORAGE_AUDIT_EXIT=$exit_code"
echo 'N2_SIZING_AUDIT_COMPLETE_STOP_REQUESTED'
exit "$exit_code"
