#!/usr/bin/env bash
# N2 private CloudOS provider continuation; guarded libvirt default NAT revalidation.
# Only existing dedicated kmj-cloudos-kvm-test and its test-only default NAT.
set -Eeuo pipefail
umask 077
URI=qemu:///system
HOST=kmj-cloudos-kvm-test
PRIVATE_SHA=9e5330cba2162e78f40763406ccfb08214dca76d34e017cc18d931a35f8fd7f5
RUNNER=/home/info_kmjtechno_com/kmj_n2_private_provider_smoke_host_20261031.sh
RUNNER_SHA=f5eef9ac16a72c29662f55cb0cd539a51da72048416511fb2bce66f16a89f5ac
T="$(mktemp -d /tmp/kmj-cloudos-n2-net-resume.XXXXXXXX)"
trap 'rm -rf -- "$T"' EXIT
echo KMJ_N2_PRIVATE_PROVIDER_NAT_RECOVERY_AND_RESUME_V1
echo SCOPE=EXISTING_N2_DEFAULT_LIBVIRT_NAT_ONLY
echo NO_PUBLIC_FIREWALL_OR_NEW_GCE_RESOURCE=YES
test "$(id -u)" -eq 0
test "$(hostname -s)" = "$HOST"
test -c /dev/kvm
test -x /usr/sbin/dnsmasq
test -f "$RUNNER" && test ! -L "$RUNNER"
echo "$RUNNER_SHA  $RUNNER" | sha256sum -c -
echo PRIVATE_PROVIDER_RUNNER_SHA256=PASS
test -f /home/info_kmjtechno_com/kmj_n2_cloudos_provider_private_20261031.tar
test ! -L /home/info_kmjtechno_com/kmj_n2_cloudos_provider_private_20261031.tar
echo "$PRIVATE_SHA  /home/info_kmjtechno_com/kmj_n2_cloudos_provider_private_20261031.tar" | sha256sum -c -
echo PRIVATE_SOURCE_ARCHIVE_SHA256=PASS
timeout 12s virsh -c "$URI" list --all --name > "$T/domains"
count="$(grep -c . "$T/domains" || true)"
echo "EXISTING_DOMAINS=$count"
test "$count" -eq 0 || { echo RESULT=BLOCKED_OTHER_LIBVIRT_DOMAINS;exit 4; }
if ! timeout 12s virsh -c "$URI" net-dumpxml default >"$T/net.xml" 2>"$T/net.err"; then
 echo RESULT=BLOCKED_DEFAULT_NETWORK_XML_UNAVAILABLE
 tail -n 4 "$T/net.err" | cut -c1-160
 exit 4
fi
ip -j -4 route show >"$T/routes.json"
if ! python3 - "$T/net.xml" "$T/routes.json" <<'PY'
import ipaddress,json,sys
from xml.etree import ElementTree as ET
root=ET.parse(sys.argv[1]).getroot()
assert root.tag=='network' and root.findtext('name')=='default'
forward=root.find('forward')
assert forward is not None and forward.get('mode')=='nat'
assert len(root.findall('forward'))==1 and not forward.findall('interface')
bridge=root.find('bridge')
assert bridge is not None and bridge.get('name')=='virbr0'
ips=root.findall('ip')
assert len(ips)==1 and ips[0].get('address')=='192.168.122.1' and ips[0].get('netmask')=='255.255.255.0'
network=ipaddress.ip_network('192.168.122.0/24')
for route in json.load(open(sys.argv[2])):
 if route.get('dst') in ('default',None) or route.get('dev')=='virbr0':
  continue
 try: other=ipaddress.ip_network(route['dst'],strict=False)
 except (KeyError,ValueError):continue
 assert not network.overlaps(other),'NAT_HOST_ROUTE_COLLISION'
print('NAT_DEFINITION_AND_ROUTE_GUARDS=PASS')
PY
then
 echo RESULT=BLOCKED_UNSAFE_DEFAULT_NAT_DEFINITION
 exit 4
fi
inspect() {
 if ! timeout 12s virsh -c "$URI" net-info default >"$T/info" 2>"$T/info.err"; then
  echo NETWORK_INFO=FAILED
  tail -n 5 "$T/info.err" | cut -c1-160
  return 1
 fi
 awk -F: '/^(Name|Active|Persistent|Autostart|Bridge):/ {
  k=$1;gsub(/[ \t\r]/,"",k);v=$2;gsub(/^[ \t]+/,"",v);
  print "NETWORK_"k"="v
 }' "$T/info"
 STATE="$(awk -F: '$1=="Active" {gsub(/[ \t\r]/,"",$2);print tolower($2)}' "$T/info" | tail -n1)"
 case "$STATE" in yes|no) ;; *) echo RESULT=BLOCKED_UNPARSEABLE_LIBVIRT_STATE;return 1;; esac
 echo "NETWORK_ACTIVE=$STATE"
}
echo BEFORE_NETWORK_INFO_BEGIN
if ! inspect; then echo RESULT=BLOCKED_LIBVIRT_NETWORK_INSPECTION;exit 5; fi
echo BEFORE_NETWORK_INFO_END
if [ "$STATE" = no ]; then
 echo ACTION=START_EXISTING_DEFAULT_NAT_ONCE
 if timeout 40s virsh -c "$URI" net-start default >"$T/start.out" 2>"$T/start.err"; then
  echo DEFAULT_NAT_START=PASS
 else
  echo DEFAULT_NAT_START=FAILED
  tail -n 8 "$T/start.err" | cut -c1-200
  echo RESULT=BLOCKED_DEFAULT_NAT_START
  exit 5
 fi
 sleep 2
else
 echo DEFAULT_NAT_START=NOT_NEEDED
fi
echo AFTER_NETWORK_INFO_BEGIN
if ! inspect; then echo RESULT=BLOCKED_LIBVIRT_NETWORK_INSPECTION;exit 5; fi
echo AFTER_NETWORK_INFO_END
if [ "$STATE" != yes ]; then echo RESULT=BLOCKED_DEFAULT_NAT_INACTIVE;exit 5; fi
if ! ip -o -4 addr show dev virbr0 2>"$T/bridge.err" | grep -Fq '192.168.122.1/24'; then
 echo RESULT=BLOCKED_VIRBR0_ADDRESS_MISSING
 tail -n 3 "$T/bridge.err" | cut -c1-160
 exit 5
fi
echo LIBVIRT_BRIDGE_IP=PASS
if ! timeout 12s virsh -c "$URI" net-autostart default >"$T/auto.out" 2>"$T/auto.err"; then
 echo RESULT=BLOCKED_DEFAULT_NAT_AUTOSTART
 tail -n 3 "$T/auto.err" | cut -c1-160
 exit 5
fi
echo NETWORK_AUTOSTART=PASS
if ! timeout 12s virsh -c "$URI" net-info default | grep -Eq '^Active:[[:space:]]*yes'; then
 echo RESULT=BLOCKED_ORIGINAL_RUNNER_NETWORK_PROBE_MISMATCH
 timeout 12s virsh -c "$URI" net-info default | head -n 12
 exit 5
fi
echo ORIGINAL_PROVIDER_NETWORK_PROBE=PASS
echo ACTION=RESUME_EXACT_VERIFIED_PRIVATE_PROVIDER_TEST
if timeout --signal=TERM --kill-after=45s 660s \
 bash "$RUNNER" run "$PRIVATE_SHA"; then
 echo RESULT=N2_REAL_PRIVATE_CLOUDOS_PROVIDER_SMOKE_PASS
else
 echo RESULT=N2_PRIVATE_PROVIDER_SMOKE_BLOCKED_WITH_EVIDENCE
 exit 6
fi
echo RECEIPT_COMPLETE=YES
