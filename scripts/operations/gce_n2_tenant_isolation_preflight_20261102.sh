#!/usr/bin/env bash
# KMJ CloudOS dedicated N2 lab: bounded READ-ONLY tenant network/guest attestation.
# GCE start is billable. The remote section never writes host settings or starts guests.
set -Eeuo pipefail
if (( $# != 3 )); then echo 'USAGE: SCRIPT PROJECT ZONE INSTANCE' >&2; exit 64; fi
PROJECT="$1"; ZONE="$2"; VM="$3"
if [[ "$PROJECT/$ZONE/$VM" != 'kmj-techno/us-central1-a/kmj-cloudos-kvm-test' ]]; then
  echo 'N2_PREFLIGHT=REFUSE_WRONG_INSTANCE'; exit 65
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
if [[ "$state" != TERMINATED ]]; then echo "N2_PREFLIGHT=REFUSE_STATUS_$state"; exit 2; fi
echo 'N2_PRECHECK=TERMINATED'
timeout 80 gcloud compute instances set-scheduling "$VM" --project="$PROJECT" \
 --zone="$ZONE" --max-run-duration=15m --instance-termination-action=STOP --quiet
limit=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(scheduling.maxRunDuration.seconds)' --quiet)
action=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(scheduling.instanceTerminationAction)' --quiet)
if [[ "$limit/$action" != '900/STOP' ]]; then
  echo 'N2_PREFLIGHT=REFUSE_AUTO_STOP_UNVERIFIED'; exit 3
fi
echo 'SERVER_SIDE_AUTO_STOP=900_SECONDS_VERIFIED'
ARMED=1
timeout 120 gcloud compute instances start "$VM" --project="$PROJECT" --zone="$ZONE" --quiet
state=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
 --zone="$ZONE" --format='value(status)' --quiet)
if [[ "$state" != RUNNING ]]; then echo "N2_PREFLIGHT=REFUSE_BOOT_$state"; exit 4; fi
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
import ipaddress
import json
import os
import subprocess
import xml.etree.ElementTree as ET

HOST = "kmj-cloudos-kvm-test"
DOMAINS = (
    "kmj-ci-kmj-validation-26b557dc40dc0d0cf5cf",
    "kmj-ci-other-tenant-8fd54398cc6bb3e5658d",
)
NETWORKS = (
    ("kmjtn-kmj-validation", "virbr71", "192.168.251.0/24"),
    ("kmjtn-other-tenant", "virbr72", "192.168.252.0/24"),
)
def cmd(*args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=25)
    if p.returncode or len(p.stdout) > 32768:
        raise RuntimeError("READ_COMMAND_FAILED:" + str(args[-1]))
    return p.stdout.strip()
def virsh(*args):
    return cmd("virsh", "-c", "qemu:///system", *args)
def flags(name):
    out = {}
    for row in virsh("net-info", name).splitlines():
        if ":" not in row:
            continue
        key, value = (x.strip().lower() for x in row.split(":", 1))
        if key in ("active", "persistent", "autostart"):
            if key in out: raise RuntimeError("DUPLICATE_NETINFO")
            out[key] = value
    return out

try:
    if os.geteuid() == 0 or os.uname().nodename.split(".")[0] != HOST:
        raise RuntimeError("HOST_IDENTITY_UNVERIFIED")
    if not os.path.exists("/dev/kvm"):
        raise RuntimeError("NO_KVM_DEVICE")
    domains = set(filter(None, virsh("list", "--all", "--name").splitlines()))
    if domains != set(DOMAINS) or virsh("list", "--name"):
        raise RuntimeError("LEGACY_DOMAIN_INVENTORY_MISMATCH")
    for name in DOMAINS:
        if virsh("domstate", name).strip().lower() != "shut off":
            raise RuntimeError("LEGACY_GUEST_NOT_SHUT_OFF")
        root = ET.fromstring(virsh("dumpxml", name))
        sources = root.findall("./devices/interface/source")
        if len(sources) != 1 or sources[0].get("network") != "default":
            raise RuntimeError("LEGACY_GUEST_NETWORK_CHANGED")
    names = set(filter(None, virsh("net-list", "--all", "--name").splitlines()))
    expected = {"default"} | {n for n, _, _ in NETWORKS}
    if names != expected:
        raise RuntimeError("TENANT_NETWORK_INVENTORY_MISMATCH")
    link_rows = json.loads(cmd("ip", "-j", "link", "show"))
    links = {row.get("ifname"): row for row in link_rows}
    observed = []
    for name, bridge, cidr in NETWORKS:
        status = flags(name)
        if any(status.get(k) != "yes" for k in ("active", "persistent", "autostart")):
            raise RuntimeError("NETWORK_NOT_ACTIVE_PERSISTENT")
        xml = ET.fromstring(virsh("net-dumpxml", name))
        if (xml.tag != "network" or xml.findtext("name") != name
                or len(xml.findall("bridge")) != 1
                or xml.find("bridge").get("name") != bridge
                or xml.findall("forward") or xml.findall("route")
                or len(xml.findall("ip")) != 1):
            raise RuntimeError("NETWORK_XML_MISMATCH")
        net = ipaddress.ip_network(cidr, strict=True)
        node = xml.find("ip")
        observed_ip = ipaddress.ip_interface(
            node.get("address", "") + "/" + (node.get("netmask") or "")
        )
        if observed_ip.network != net or observed_ip.ip != net.network_address + 1:
            raise RuntimeError("NETWORK_GATEWAY_OR_CIDR_MISMATCH")
        pools = node.findall("./dhcp/range")
        if (len(pools) != 1 or
                ipaddress.ip_address(pools[0].get("start", "")) != net.network_address + 100 or
                ipaddress.ip_address(pools[0].get("end", "")) != net.network_address + 200):
            raise RuntimeError("NETWORK_DHCP_RANGE_MISMATCH")
        if bridge not in links or "UP" not in links[bridge].get("flags", []):
            raise RuntimeError("NETWORK_BRIDGE_NOT_UP")
        observed.append(net)
        print("TENANT_NETWORK_ATTESTED=" + name + "|" + bridge + "|" + cidr)
        print("TENANT_LEASE_COUNT=" + name + "|" +
              str(max(0, len([row for row in virsh("net-dhcp-leases", name).splitlines()
                               if "ipv4" in row.lower()]))))
    if observed[0].overlaps(observed[1]):
        raise RuntimeError("OVERLAPPING_TENANT_CIDRS")
    print("EXISTING_LEGACY_DOMAINS=2_SHUT_OFF_UNMODIFIED")
    print("N2_ISOLATED_NETWORK_PREFLIGHT=PASS_READ_ONLY")
    print("LIVE_CROSS_TENANT_NEGATIVE_TEST=NOT_VERIFIED")
    print("QGA_DHCP_GUEST_READY_TEST=NOT_VERIFIED")
    print("INDEPENDENT_RESTORE_ROLLBACK=NOT_VERIFIED")
    print("COMMERCIAL_RELEASE=BLOCKED")
except Exception as exc:
    print("N2_ISOLATED_NETWORK_PREFLIGHT=BLOCKED")
    print("N2_PREFLIGHT_REASON=" + str(exc)[:180])
    raise SystemExit(2)
PY
REMOTE_SCRIPT
)
set +e
timeout 260 gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" \
 --tunnel-through-iap --quiet --command="$REMOTE"
exit_code=$?
set -e
echo "N2_HOST_READONLY_EXIT=$exit_code"
echo 'N2_AUDIT_COMPLETE_STOP_REQUESTED'
exit "$exit_code"
