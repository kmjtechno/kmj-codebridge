#!/usr/bin/env bash
# Operator-initiated Cloud Shell lab provisioning. Compute runtime may be billable.
# Creates only two new isolated libvirt networks; never edits legacy domains or disks.
set -Eeuo pipefail
if (( $# != 3 )); then echo "USAGE: $0 PROJECT ZONE VM" >&2; exit 64; fi
PROJECT="$1"; ZONE="$2"; VM="$3"
[[ "$PROJECT/$ZONE/$VM" == "kmj-techno/us-central1-a/kmj-cloudos-kvm-test" ]] || {
  echo "REFUSE_OTHER_VM" >&2; exit 64;
}
for c in gcloud timeout; do command -v "$c" >/dev/null || exit 69; done
ARMED=0
stop_host() {
  trap - EXIT HUP INT TERM
  if [[ "$ARMED" == 1 ]]; then
    echo "VM_STOP=REQUESTING"
    timeout 180 gcloud compute instances stop "$VM" --project="$PROJECT" \
      --zone="$ZONE" --quiet || echo "VM_STOP_RETRY_REQUIRED"
    final=$(timeout 35 gcloud compute instances describe "$VM" \
      --project="$PROJECT" --zone="$ZONE" --quiet --format='value(status)' 2>/dev/null || true)
    echo "VM_FINAL_STATE=$final"
    if [[ "$final" != TERMINATED ]]; then
      echo "STOP_MANUALLY: gcloud compute instances stop $VM --project=$PROJECT --zone=$ZONE --quiet"
    fi
  fi
}
trap stop_host EXIT
trap 'exit 130' HUP INT TERM
state=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
  --zone="$ZONE" --quiet --format='value(status)')
[[ "$state" == TERMINATED ]] || { echo "REFUSE_START_VM_STATE=$state" >&2; exit 2; }
echo "N2_PRECHECK=TERMINATED"
timeout 80 gcloud compute instances set-scheduling "$VM" --project="$PROJECT" \
  --zone="$ZONE" --max-run-duration=15m --instance-termination-action=STOP --quiet
seconds=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
  --zone="$ZONE" --quiet --format='value(scheduling.maxRunDuration.seconds)')
action=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
  --zone="$ZONE" --quiet --format='value(scheduling.instanceTerminationAction)')
[[ "$seconds/$action" == "900/STOP" ]] || { echo "REFUSE_AUTO_STOP_NOT_VERIFIED"; exit 3; }
echo "SERVER_SIDE_AUTO_STOP=900_SECONDS_VERIFIED"
ARMED=1
timeout 120 gcloud compute instances start "$VM" --project="$PROJECT" --zone="$ZONE" --quiet
state=$(timeout 35 gcloud compute instances describe "$VM" --project="$PROJECT" \
  --zone="$ZONE" --quiet --format='value(status)')
[[ "$state" == RUNNING ]] || { echo "VM_START_NOT_CONFIRMED=$state"; exit 4; }
echo "VM_RUNNING=VERIFIED"
REMOTE=$(cat <<'REMOTE_CODE'
python3 - <<'PY'
import ipaddress
import json
import os
import subprocess
import tempfile
import xml.etree.ElementTree as ET

PREFIX = ("virsh", "-c", "qemu:///system")
DOMAINS = {
    "kmj-ci-kmj-validation-26b557dc40dc0d0cf5cf",
    "kmj-ci-other-tenant-8fd54398cc6bb3e5658d",
}
PLANS = (
    ("kmjtn-kmj-validation", "virbr71", "192.168.251.0/24"),
    ("kmjtn-other-tenant", "virbr72", "192.168.252.0/24"),
)

def call(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=25)
    if p.returncode:
        raise RuntimeError("FAILED_COMMAND=" + args[-1] + " EXIT=" + str(p.returncode))
    return p.stdout.strip()

def virsh(*args):
    return call([*PREFIX, *args])

def network_xml(name, bridge, cidr):
    net = ipaddress.ip_network(cidr)
    return ("<network><name>" + name + "</name><bridge name='" + bridge +
            "'/><ip address='" + str(net.network_address+1) +
            "' netmask='255.255.255.0'><dhcp><range start='" +
            str(net.network_address+100) + "' end='" +
            str(net.network_address+200) + "'/></dhcp></ip></network>")

def net_info_flags(name):
    # virsh aligns labels with spaces, for example 'Active:         yes'.
    # Require an exact unique field key but normalize surrounding whitespace.
    flags = {}
    for row in virsh("net-info", name).splitlines():
        if ":" not in row:
            continue
        key, value = row.split(":", 1)
        key = key.strip().lower()
        if key in {"active", "autostart", "persistent"}:
            if key in flags:
                raise RuntimeError("NETWORK_INFO_DUPLICATE_FIELD")
            flags[key] = value.strip().lower()
    return flags

def verify(name, bridge, cidr):
    root = ET.fromstring(virsh("net-dumpxml", name))
    net = ipaddress.ip_network(cidr)
    bridges = root.findall("bridge")
    addresses = root.findall("ip")
    if (root.tag != "network" or len(root.findall("name")) != 1
        or root.findtext("name") != name
        or len(bridges) != 1 or bridges[0].get("name") != bridge
        or len(addresses) != 1
        or root.findall("forward") or root.findall("route")
        or root.findall("portgroup")):
        raise RuntimeError("NETWORK_XML_ATTESTATION_FAILED")
    addr = addresses[0]
    iface = ipaddress.ip_interface(addr.get("address", "") + "/" + addr.get("netmask", ""))
    if iface.network != net or iface.ip != net.network_address + 1:
        raise RuntimeError("NETWORK_SUBNET_MISMATCH")
    ranges = addr.findall("dhcp/range")
    if (len(ranges) != 1 or
        ipaddress.ip_address(ranges[0].get("start", "")) != net.network_address+100
        or ipaddress.ip_address(ranges[0].get("end", "")) != net.network_address+200):
        raise RuntimeError("NETWORK_POOL_MISMATCH")
    status = net_info_flags(name)
    if any(status.get(field) != "yes"
           for field in ("active", "autostart", "persistent")):
        raise RuntimeError("NETWORK_NOT_ACTIVE_PERSISTENT")

created = []
try:
    if os.geteuid() == 0:
        raise RuntimeError("REFUSE_ROOT_SESSION")
    domains = set(virsh("list", "--all", "--name").splitlines())
    active = set(virsh("list", "--name").splitlines())
    if domains != DOMAINS or active:
        raise RuntimeError("REFUSE_UNEXPECTED_OR_RUNNING_GUESTS")
    existing = set(virsh("net-list", "--all", "--name").splitlines())
    expected = {"default"} | {spec[0] for spec in PLANS}
    if existing == expected:
        for spec in PLANS:
            verify(*spec)
        print("TENANT_NETWORKS=ALREADY_PRESENT_VERIFIED")
    elif existing == {"default"}:
        routes = json.loads(call(["ip", "-j", "-4", "route", "show", "table", "all"]))
        for name, bridge, cidr in PLANS:
            target = ipaddress.ip_network(cidr)
            for row in routes:
                dest = row.get("dst", "default")
                if dest != "default" and target.overlaps(ipaddress.ip_network(dest, strict=False)):
                    raise RuntimeError("HOST_ROUTE_SUBNET_CONFLICT")
        for name, bridge, cidr in PLANS:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".xml", delete=False) as handle:
                handle.write(network_xml(name, bridge, cidr))
                namepath = handle.name
            try:
                virsh("net-define", namepath)
                created.append(name)
            finally:
                os.unlink(namepath)
            virsh("net-start", name)
            virsh("net-autostart", name)
            verify(name, bridge, cidr)
        print("TENANT_NETWORKS=CREATED_AND_VERIFIED")
    else:
        raise RuntimeError("REFUSE_UNKNOWN_LIBVIRT_NETWORK_INVENTORY")
    if set(virsh("list", "--all", "--name").splitlines()) != DOMAINS:
        raise RuntimeError("LEGACY_DOMAIN_INVENTORY_CHANGED")
    if set(virsh("list", "--name").splitlines()):
        raise RuntimeError("LEGACY_DOMAIN_STARTED")
    for domain in sorted(DOMAINS):
        if "default" not in virsh("domiflist", domain):
            raise RuntimeError("LEGACY_DOMAIN_INTERFACE_CHANGED")
    print("HOST_NETWORK_CONFIG=PASS")
    print("OLD_GUESTS=UNCHANGED_SHUT_OFF")
    print("TENANT_GUEST_MIGRATION=NOT_ATTEMPTED")
    print("LIVE_L2_ISOLATION=NOT_VERIFIED")
    print("PRODUCTION_RELEASE_CREDIT=NO")
except Exception as exc:
    print("HOST_NETWORK_CONFIG=BLOCKED")
    print("HOST_NETWORK_REASON=" + str(exc)[:180])
    # Roll back only networks newly created by THIS invocation.
    for name in reversed(created):
        try:
            virsh("net-destroy", name)
        except Exception:
            pass
        try:
            virsh("net-undefine", name)
        except Exception:
            pass
    if created:
        try:
            remaining = set(virsh("net-list", "--all", "--name").splitlines())
            if any(name in remaining for name in created):
                print("NEW_NETWORK_ROLLBACK=FAILED_RECHECK_REQUIRED")
            else:
                print("NEW_NETWORK_ROLLBACK=VERIFIED_LIBVIRT_DEFINITIONS_ABSENT")
        except Exception:
            print("NEW_NETWORK_ROLLBACK=UNVERIFIED_RECHECK_REQUIRED")
    raise SystemExit(2)
PY
REMOTE_CODE
)
set +e
timeout 360 gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" \
  --tunnel-through-iap --quiet --command="$REMOTE"
result=$?
set -e
echo "HOST_NETWORK_AUDIT_EXIT=$result"
echo "NETWORK_WINDOW_END_REQUEST_STOP"
exit "$result"
