#!/usr/bin/env bash
# KMJ CloudOS: prepare existing N2 KVM test VM for a future scoped compute-provider test.
set -Eeuo pipefail
umask 077
HOST=kmj-cloudos-kvm-test
URI=qemu:///system
OUT=/var/tmp/kmj_cloudos_n2_compute_prerequisites_20261031.txt
test "$(id -u)" -eq 0 || { echo ROOT_REQUIRED; exit 2; }
test "$(hostname -s)" = "$HOST" || { echo WRONG_HOST; exit 2; }
test -c /dev/kvm
command -v virsh >/dev/null
command -v apt-get >/dev/null
TMP="$(mktemp -d /tmp/kmj-n2-prereq.XXXXXXXX)"
started=no
passed=no
cleanup() {
  rc=$?
  trap - EXIT
  if [ "$passed" != yes ] && [ "$started" = yes ]; then
    if [ "$(timeout 8s virsh -c "$URI" list --all --name 2>/dev/null | grep -c . || true)" -eq 0 ]; then
      timeout 20s virsh -c "$URI" net-destroy default >/dev/null 2>&1 || true
      echo 'FAILED_RUN_DEFAULT_NETWORK_ROLLBACK=ATTEMPTED'
    fi
  fi
  rm -rf -- "$TMP"
  exit "$rc"
}
trap cleanup EXIT
exec > >(tee "$OUT") 2>&1
echo KMJ_CLOUDOS_N2_PREREQUISITES_V1
echo SCOPE=QEMU_UTILS_AND_EXISTING_DEFAULT_NAT_ONLY
echo PUBLIC_FIREWALL_OR_GCE_INSTANCE=UNCHANGED
count="$(timeout 12s virsh -c "$URI" list --all --name | grep -c . || true)"
echo "EXISTING_DOMAINS=$count"
test "$count" -eq 0 || { echo BLOCKED=GUEST_DOMAIN_PRESENT; exit 3; }
if ! command -v qemu-img >/dev/null 2>&1; then
  echo 'QEMU_IMG=REPAIR_FROM_UBUNTU_APT'
  export DEBIAN_FRONTEND=noninteractive
  if timeout 240s apt-get -o DPkg::Lock::Timeout=30 -y --no-install-recommends --no-remove install --reinstall qemu-utils >"$TMP/apt.out" 2>"$TMP/apt.err"; then
    echo QEMU_UTILS_INSTALL=PASS
  else
    echo QEMU_UTILS_INSTALL=FAILED
    tail -n 8 "$TMP/apt.err" | cut -c1-180
    exit 4
  fi
fi
if ! command -v qemu-img >/dev/null 2>&1; then
  echo QEMU_IMG=MISSING_AFTER_APT
  exit 5
fi
echo QEMU_IMG=PASS
qemu-img --version | head -n 1 | cut -c1-150
timeout 10s virsh -c "$URI" net-dumpxml default >"$TMP/net.xml"
ip -j -4 route show >"$TMP/routes.json"
python3 - "$TMP/net.xml" "$TMP/routes.json" <<'PY'
import ipaddress,json,sys
from xml.etree import ElementTree as ET
x=ET.parse(sys.argv[1]).getroot()
assert x.tag=='network' and x.findtext('name')=='default'
fw=x.find('forward')
assert fw is not None and fw.attrib.get('mode')=='nat'
assert not fw.findall('interface')
assert len(x.findall('forward'))==1
bridge=x.find('bridge')
assert bridge is not None and bridge.attrib.get('name')=='virbr0'
ip=x.findall('ip')
assert len(ip)==1 and ip[0].get('address')=='192.168.122.1' and ip[0].get('netmask')=='255.255.255.0'
target=ipaddress.ip_network('192.168.122.0/24')
for item in json.load(open(sys.argv[2])):
    if item.get('dev')=='virbr0' or item.get('dst') in (None,'default'): continue
    try: network=ipaddress.ip_network(item['dst'],strict=False)
    except (KeyError,ValueError): continue
    assert not target.overlaps(network), 'Overlapping host route'
print('NETWORK_XML_AND_ROUTES=PASS')
PY
if timeout 10s virsh -c "$URI" net-info default | grep -Eq '^Active:[[:space:]]+yes'; then
  echo DEFAULT_NET=ALREADY_ACTIVE
else
  echo DEFAULT_NET=STARTING_NAT
  if timeout 40s virsh -c "$URI" net-start default >"$TMP/start.out" 2>"$TMP/start.err"; then
    started=yes
    echo DEFAULT_NET_START=PASS
  else
    echo DEFAULT_NET_START=FAILED
    tail -n 8 "$TMP/start.err" | cut -c1-175
    exit 6
  fi
fi
timeout 12s virsh -c "$URI" net-info default | grep -Eq '^Active:[[:space:]]+yes'
echo DEFAULT_NET_ACTIVE=PASS
timeout 15s virsh -c "$URI" net-autostart default >/dev/null
echo DEFAULT_NET_AUTOSTART=PASS
if [ -d /var/lib/libvirt/images ] && [ ! -L /var/lib/libvirt/images ]; then
  echo IMAGE_DIRECTORY=READABLE_AS_ROOT
  echo "QCOW2_COUNT=$(find /var/lib/libvirt/images -maxdepth 1 -type f -name '*.qcow2' | wc -l)"
  echo "IMG_COUNT=$(find /var/lib/libvirt/images -maxdepth 1 -type f -name '*.img' | wc -l)"
else
  echo IMAGE_DIRECTORY=ABSENT_OR_UNSAFE
fi
echo QGA_GUEST_AGENT=NEEDS_VERIFIED_GUEST_IMAGE
echo CLOUDOS_AUTHENTICATED_NODE_PAIRING=PENDING
echo RESULT=LOCAL_COMPUTE_PREREQUISITES_PASS
echo RECEIPT_COMPLETE=YES
passed=yes
