#!/usr/bin/env bash
# KMJ CloudOS dedicated N2 lab: bounded READ-ONLY N2-to-ELITE network reachability and fingerprint attestation.
# GCE start is billable. The remote section never writes host settings or starts guests.
set -Eeuo pipefail
if (( $# != 3 )); then echo 'USAGE: SCRIPT PROJECT ZONE INSTANCE' >&2; exit 64; fi
PROJECT="$1"; ZONE="$2"; VM="$3"
if [[ "$PROJECT/$ZONE/$VM" != 'kmj-techno/us-central1-a/kmj-cloudos-kvm-test' ]]; then
  echo 'N2_ELITE_SSH_PREFLIGHT=REFUSE_WRONG_INSTANCE'; exit 65
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
if [[ "$state" != TERMINATED ]]; then echo "N2_ELITE_SSH_PREFLIGHT=REFUSE_STATUS_$state"; exit 2; fi
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
timeout 80 gcloud compute instances set-scheduling "$VM" --project="$PROJECT" \
 --zone="$ZONE" --max-run-duration=15m --instance-termination-action=STOP --quiet
limit=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(scheduling.maxRunDuration.seconds)' --quiet)
action=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(scheduling.instanceTerminationAction)' --quiet)
if [[ "$limit/$action" != '900/STOP' ]]; then
  echo 'N2_ELITE_SSH_PREFLIGHT=REFUSE_AUTO_STOP_UNVERIFIED'; exit 3
fi
echo 'SERVER_SIDE_AUTO_STOP=900_SECONDS_VERIFIED'
ARMED=1
timeout 120 gcloud compute instances start "$VM" --project="$PROJECT" --zone="$ZONE" --quiet
state=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(status)' --quiet)
if [[ "$state" != RUNNING ]]; then echo "N2_ELITE_SSH_PREFLIGHT=REFUSE_BOOT_$state"; exit 4; fi
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
import base64
import binascii
import ipaddress
import json
import os
import re
import subprocess
import urllib.request

ELITE_IP = "103.212.136.154"
EXPECTED_FINGERPRINT = "SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI"
KEY_TYPE = "ssh-ed25519"
HOST = "kmj-cloudos-kvm-test"
PROJECT = "kmj-techno"
ZONE = "us-central1-a"
SSH_KEY_FIELD = re.compile(r"[A-Za-z0-9+/]+={0,2}\Z")

def metadata(endpoint):
    request = urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/" + endpoint,
        headers={"Metadata-Flavor": "Google"}
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=4) as response:
        if response.headers.get("Metadata-Flavor") != "Google":
            raise RuntimeError("GCE_METADATA_RESPONSE_NOT_VERIFIED")
        return response.read(300).decode("utf-8").strip()

def read(argv, *, data=None, seconds=15):
    try:
        p = subprocess.run(argv, input=data, capture_output=True,
                           text=True, timeout=seconds, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("READ_COMMAND_UNAVAILABLE_OR_TIMEOUT")
    if p.returncode or len(p.stdout.encode("utf-8")) > 16384:
        raise RuntimeError("READ_COMMAND_FAILED")
    return p.stdout.strip()

def fingerprint(ip):
    if not ipaddress.ip_address(ip).is_global:
        raise RuntimeError("NOT_PUBLIC_ELITE_IP")
    scan = read(["ssh-keyscan", "-4", "-T", "5",
                 "-p", "22", "-t", KEY_TYPE, ip], seconds=11)
    rows = [x.strip() for x in scan.splitlines()
            if x.strip() and not x.lstrip().startswith("#")]
    if len(rows) != 1:
        raise RuntimeError("REMOTE_ED25519_HOSTKEY_COUNT_MISMATCH")
    parts = rows[0].split()
    if (len(parts) != 3 or parts[0] != ip or
            parts[1] != KEY_TYPE or not SSH_KEY_FIELD.fullmatch(parts[2]) or
            len(parts[2]) > 2048):
        raise RuntimeError("REMOTE_HOSTKEY_RECORD_MISMATCH")
    try:
        raw = base64.b64decode(parts[2], validate=True)
    except (ValueError, binascii.Error):
        raise RuntimeError("REMOTE_HOSTKEY_INVALID_ENCODING")
    if len(raw) < 40 or len(raw) > 1024:
        raise RuntimeError("REMOTE_HOSTKEY_INVALID_LENGTH")
    result = read(["ssh-keygen", "-l", "-E", "sha256", "-f", "-"],
                  data=rows[0] + "\n", seconds=8).splitlines()
    if len(result) != 1:
        raise RuntimeError("ED25519_FINGERPRINT_COUNT_MISMATCH")
    tokens = result[0].split()
    if len(tokens) < 3 or tokens[1] != EXPECTED_FINGERPRINT:
        raise RuntimeError("REMOTE_ED25519_FINGERPRINT_MISMATCH")
    return True

def virsh(*args):
    return read(["virsh", "-c", "qemu:///system", *args], seconds=18)

try:
    if (os.geteuid() == 0 or os.uname().nodename.split(".")[0] != HOST or
            metadata("instance/name") != HOST or
            metadata("project/project-id") != PROJECT or
            not metadata("instance/zone").endswith("/" + ZONE)):
        raise RuntimeError("N2_HOST_IDENTITY_UNVERIFIED")
    expected = {
        "kmj-ci-kmj-validation-26b557dc40dc0d0cf5cf",
        "kmj-ci-other-tenant-8fd54398cc6bb3e5658d",
    }
    existing = set(filter(None, virsh("list", "--all", "--name").splitlines()))
    if existing != expected or virsh("list", "--name"):
        raise RuntimeError("LEGACY_GUESTS_NOT_UNCHANGED_SHUT_OFF")
    print("N2_HOST_AND_OLD_GUESTS=READ_ONLY_VERIFIED", flush=True)
    fingerprint(ELITE_IP)
    print("N2_TO_ELITE_SSH22=REACHABLE", flush=True)
    print("N2_TO_ELITE_ED25519_FINGERPRINT=PINNED_MATCH_VERIFIED", flush=True)
    print("N2_TO_ELITE_HOST_KEY_SCAN=NO_KNOWN_HOSTS_WRITE", flush=True)
    print("N2_TO_ELITE_REACHABILITY=PASS_READ_ONLY", flush=True)
    print("ELITE_SSH_LOGIN_AUTHORIZATION=NOT_TESTED", flush=True)
    print("ELITE_RESTRICTED_UPLOAD_IDENTITY=NOT_VERIFIED", flush=True)
    print("AGE_RECOVERY_RECIPIENT=NOT_VERIFIED", flush=True)
    print("CONSISTENT_N2_BOOT_DISK_CAPTURE=NOT_ATTEMPTED", flush=True)
    print("ENCRYPTED_BACKUP_STREAM=NOT_ATTEMPTED", flush=True)
    print("INDEPENDENT_DISPOSABLE_RESTORE=NOT_VERIFIED", flush=True)
    print("CLOUDOS_COMMERCIAL_RELEASE=BLOCKED", flush=True)
except Exception as error:
    print("N2_TO_ELITE_PINNED_SSH_PREFLIGHT=BLOCKED", flush=True)
    print("N2_ELITE_PROBE_REASON=" + str(error)[:160], flush=True)
    raise SystemExit(2)
PY
REMOTE_SCRIPT
)
set +e
timeout 260 gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" \
 --tunnel-through-iap --quiet --command="$REMOTE"
exit_code=$?
set -e
echo "N2_ELITE_SSH_READONLY_EXIT=$exit_code"
echo 'N2_ELITE_SSH_AUDIT_COMPLETE_STOP_REQUESTED'
exit "$exit_code"
