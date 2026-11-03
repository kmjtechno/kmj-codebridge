#!/usr/bin/env bash
# KMJ CloudOS dedicated N2 lab: bounded READ-ONLY N2-to-existing-internal-relay TCP22 and SSH banner probe.
# GCE start is billable. The remote section never writes host settings or starts guests.
set -Eeuo pipefail
if (( $# != 3 )); then echo 'USAGE: SCRIPT PROJECT ZONE INSTANCE' >&2; exit 64; fi
PROJECT="$1"; ZONE="$2"; VM="$3"
if [[ "$PROJECT/$ZONE/$VM" != 'kmj-techno/us-central1-a/kmj-cloudos-kvm-test' ]]; then
  echo 'N2_RELAY_TCP22_PREFLIGHT=REFUSE_WRONG_INSTANCE'; exit 65
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
if [[ "$state" != TERMINATED ]]; then echo "N2_RELAY_TCP22_PREFLIGHT=REFUSE_STATUS_$state"; exit 2; fi
echo 'N2_PRECHECK=TERMINATED'
# Fail closed on previously verified protection flags before any billable start.
guard=$(timeout 40 gcloud compute instances describe "$VM" \
  --project="$PROJECT" --zone="$ZONE" --format=json --quiet |
  python3 -c '
import json,sys
d=json.load(sys.stdin)
disks=d.get("disks")
valid=(d.get("name")=="kmj-cloudos-kvm-test"
   and d.get("status")=="TERMINATED"
   and d.get("deletionProtection") is True
   and isinstance(disks,list) and len(disks)==1
   and disks[0].get("boot") is True
   and disks[0].get("autoDelete") is False)
print("PROTECTED" if valid else "BLOCKED")
')
if [[ "$guard" != PROTECTED ]]; then
  echo 'N2_DELETION_GUARDS=BLOCKED_NOT_VERIFIED'
  exit 2
fi
echo 'N2_DELETION_GUARDS=PROTECTED_VERIFIED'
# Verify exact candidate identity/running state without changing its guest.
relay_guard=$(timeout 40 gcloud compute instances describe \
  'instance-20260912-094732' --project="$PROJECT" --zone="$ZONE" \
  --format=json --quiet | python3 -c '
import json,sys
d=json.load(sys.stdin)
nics=d.get("networkInterfaces")
valid=(d.get("name")=="instance-20260912-094732"
    and d.get("status")=="RUNNING" and isinstance(nics,list)
    and len(nics)==1 and nics[0].get("networkIP")=="10.128.0.2"
    and nics[0].get("network","").endswith("/global/networks/default")
    and nics[0].get("subnetwork","").endswith("/regions/us-central1/subnetworks/default")
    and any(isinstance(x,dict) and x.get("type")=="ONE_TO_ONE_NAT"
            and x.get("natIP") for x in nics[0].get("accessConfigs",[])))
print("EXACT_EXISTING_RELAY" if valid else "BLOCKED")
')
if [[ "$relay_guard" != EXACT_EXISTING_RELAY ]]; then
  echo 'RELAY_PRECHECK=BLOCKED_EXACT_IDENTITY_UNVERIFIED'
  exit 2
fi
echo 'RELAY_PRECHECK=EXACT_EXISTING_RUNNING_VERIFIED'
timeout 80 gcloud compute instances set-scheduling "$VM" --project="$PROJECT" \
 --zone="$ZONE" --max-run-duration=15m --instance-termination-action=STOP --quiet
limit=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(scheduling.maxRunDuration.seconds)' --quiet)
action=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(scheduling.instanceTerminationAction)' --quiet)
if [[ "$limit/$action" != '900/STOP' ]]; then
  echo 'N2_RELAY_TCP22_PREFLIGHT=REFUSE_AUTO_STOP_UNVERIFIED'; exit 3
fi
echo 'SERVER_SIDE_AUTO_STOP=900_SECONDS_VERIFIED'
ARMED=1
timeout 120 gcloud compute instances start "$VM" --project="$PROJECT" --zone="$ZONE" --quiet
state=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(status)' --quiet)
if [[ "$state" != RUNNING ]]; then echo "N2_RELAY_TCP22_PREFLIGHT=REFUSE_BOOT_$state"; exit 4; fi
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
import os
import socket
import subprocess
import urllib.request

HOST = "kmj-cloudos-kvm-test"
PROJECT = "kmj-techno"
ZONE = "us-central1-a"
RELAY_IP = "10.128.0.2"
LEGACY_DOMAINS = {
  "kmj-ci-kmj-validation-26b557dc40dc0d0cf5cf",
  "kmj-ci-other-tenant-8fd54398cc6bb3e5658d",
}

def metadata(endpoint):
    r = urllib.request.Request(
      "http://metadata.google.internal/computeMetadata/v1/" + endpoint,
      headers={"Metadata-Flavor": "Google"}
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(r, timeout=4) as x:
        if x.headers.get("Metadata-Flavor") != "Google":
            raise RuntimeError("METADATA_FLAVOR_UNVERIFIED")
        return x.read(300).decode("utf-8").strip()

def read(*args):
    p = subprocess.run(args, capture_output=True, text=True,
                       check=False, timeout=15)
    if p.returncode or len(p.stdout) > 16384:
        raise RuntimeError("LEGACY_DOMAINS_READ_FAILED")
    return p.stdout.strip()

try:
    if (os.geteuid() == 0 or os.uname().nodename.split(".")[0] != HOST
            or metadata("instance/name") != HOST
            or metadata("project/project-id") != PROJECT
            or not metadata("instance/zone").endswith("/" + ZONE)):
        raise RuntimeError("EXACT_N2_METADATA_IDENTITY_BLOCKED")
    existing = set(filter(None, read("virsh", "-c", "qemu:///system",
                                     "list", "--all", "--name").splitlines()))
    running = read("virsh", "-c", "qemu:///system", "list", "--name")
    if existing != LEGACY_DOMAINS or running:
        raise RuntimeError("LEGACY_GUEST_STATE_CHANGED")
    print("N2_IDENTITY_AND_LEGACY_GUESTS=PASS_READ_ONLY", flush=True)
    try:
        with socket.create_connection((RELAY_IP, 22), timeout=6) as connection:
            connection.settimeout(5)
            print("N2_TO_RELAY_TCP22=REACHABLE", flush=True)
            try:
                banner = connection.recv(160)
            except socket.timeout:
                banner = b""
    except ConnectionRefusedError:
        raise RuntimeError("RELAY_TCP22_CONNECTION_REFUSED")
    except socket.timeout:
        raise RuntimeError("RELAY_TCP22_CONNECTION_TIMEOUT")
    except OSError:
        raise RuntimeError("RELAY_TCP22_NETWORK_OR_OS_ERROR")
    if banner.startswith(b"SSH-2.0-") and b"\n" in banner and len(banner) <= 160:
        print("N2_TO_RELAY_SSH_PROTOCOL_BANNER=SSH2_OBSERVED", flush=True)
    else:
        print("N2_TO_RELAY_SSH_PROTOCOL_BANNER=NOT_VERIFIED", flush=True)
    print("N2_TO_RELAY_NETWORK_CONNECTIVITY=PASS_TCP22_ONLY", flush=True)
    print("RELAY_SSH_HOST_IDENTITY=UNVERIFIED_DO_NOT_TRUST_KEYSCAN", flush=True)
    print("RELAY_SSH_AUTHORIZATION=NOT_TESTED", flush=True)
    print("RELAY_TO_ELITE_ED25519_TRUST_AND_EGRESS=NOT_TESTED", flush=True)
    print("ENCRYPTED_BOOT_DISK_BACKUP_TRANSFER=NOT_ATTEMPTED", flush=True)
    print("INDEPENDENT_DISPOSABLE_RESTORE=NOT_VERIFIED", flush=True)
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)
except Exception as error:
    print("N2_TO_RELAY_TCP22_PREFLIGHT=BLOCKED", flush=True)
    print("N2_RELAY_REASON=" + str(error)[:120], flush=True)
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)
    raise SystemExit(2)
PY
REMOTE_SCRIPT
)
set +e
timeout 260 gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" \
 --tunnel-through-iap --quiet --command="$REMOTE"
exit_code=$?
set -e
echo "N2_RELAY_TCP22_READONLY_EXIT=$exit_code"
echo 'N2_RELAY_TCP22_AUDIT_COMPLETE_STOP_REQUESTED'
exit "$exit_code"
