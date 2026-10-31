#!/usr/bin/env bash
# KMJ CloudOS N2 network recovery / evidence V2.
# Only the existing default libvirt NAT on dedicated test VM may be started.
set -u
umask 077
VM=kmj-cloudos-kvm-test
URI=qemu:///system
OUT=/var/tmp/kmj_cloudos_n2_network_recovery_v2_20261031.txt
TMP="$(mktemp -d /tmp/kmj-n2-network-v2.XXXXXXXX)"
trap 'rm -rf -- "$TMP"' EXIT
exec > >(tee "$OUT") 2>&1
echo KMJ_CLOUDOS_N2_NETWORK_RECOVERY_V2
echo SCOPE=DEDICATED_N2_DEFAULT_NAT_ONLY
echo GCE_RESOURCES_AND_PUBLIC_FIREWALL=UNCHANGED
if [ "$(hostname -s)" != "$VM" ] || [ "$(id -u)" != 0 ]; then
 echo RESULT=BLOCKED_WRONG_HOST_OR_USER
 exit 0
fi
if [ ! -c /dev/kvm ] || [ ! -x /usr/sbin/dnsmasq ] || ! command -v qemu-img >/dev/null 2>&1; then
 echo RESULT=BLOCKED_MISSING_PREREQUISITE
 exit 0
fi
if ! timeout 12s virsh -c "$URI" list --all --name >"$TMP/domains" 2>"$TMP/domain.err"; then
 echo RESULT=BLOCKED_LIBVIRT_CONNECTION
 exit 0
fi
COUNT="$(grep -c . "$TMP/domains" || true)"
echo "DOMAINS=$COUNT"
if [ "$COUNT" -ne 0 ]; then
 echo RESULT=BLOCKED_NONEMPTY_DOMAIN_INVENTORY
 exit 0
fi
if ! timeout 12s virsh -c "$URI" net-dumpxml default >"$TMP/default.xml" 2>"$TMP/net.err"; then
 echo RESULT=BLOCKED_MISSING_DEFAULT_NETWORK
 exit 0
fi
ip -j -4 route show >"$TMP/routes.json"
if ! python3 - "$TMP/default.xml" "$TMP/routes.json" <<'PY'
import json,ipaddress,sys
from xml.etree import ElementTree as ET
x=ET.parse(sys.argv[1]).getroot()
assert x.tag=='network' and x.findtext('name')=='default'
f=x.find('forward')
assert f is not None and f.get('mode')=='nat'
assert len(x.findall('forward'))==1 and not f.findall('interface')
b=x.find('bridge')
assert b is not None and b.get('name')=='virbr0'
ips=x.findall('ip')
assert len(ips)==1 and ips[0].get('address')=='192.168.122.1' and ips[0].get('netmask')=='255.255.255.0'
t=ipaddress.ip_network('192.168.122.0/24')
for row in json.load(open(sys.argv[2])):
 if row.get('dst') in (None,'default') or row.get('dev')=='virbr0':continue
 try: r=ipaddress.ip_network(row['dst'],strict=False)
 except (KeyError,ValueError):continue
 assert not t.overlaps(r),'HOST_ROUTE_OVERLAP'
print('NETWORK_GUARD=PASS')
PY
then
 echo RESULT=BLOCKED_UNSAFE_NETWORK_DEFINITION
 exit 0
fi
inspect() {
 if timeout 12s virsh -c "$URI" net-info default >"$TMP/info" 2>"$TMP/info.err"; then
  awk -F: '/^(Name|Active|Persistent|Autostart|Bridge):/ {gsub(/^[ \t]+/,"",$2); print "NET_"$1"="$2}' "$TMP/info"
  STATE="$(awk -F: '$1=="Active" {gsub(/[ \t\r]/,"",$2);print tolower($2)}' "$TMP/info" | tail -n1)"
  echo "PARSED_NETWORK_ACTIVE=$STATE"
 else
  STATE=unavailable
  echo NET_INFO=FAILED
  tail -n 4 "$TMP/info.err" | cut -c1-160
 fi
}
echo BEFORE_INFO_BEGIN
inspect
echo BEFORE_INFO_END
if [ "$STATE" != yes ]; then
 echo ACTION=RETRY_NET_START_ONCE
 if timeout 35s virsh -c "$URI" net-start default >"$TMP/start.out" 2>"$TMP/start.err"; then
  echo NET_START=PASS
 else
  echo NET_START=FAILED
  tail -n 8 "$TMP/start.err" | cut -c1-170
 fi
 sleep 2
fi
echo AFTER_INFO_BEGIN
inspect
echo AFTER_INFO_END
echo BRIDGE_STATUS_BEGIN
ip -br -4 addr show dev virbr0 2>/dev/null | cut -c1-180 || echo BRIDGE=NOT_PRESENT
echo BRIDGE_STATUS_END
echo DNSMASQ_PROCESS_COUNT="$(pgrep -fc '/usr/sbin/dnsmasq.*libvirt' 2>/dev/null || true)"
if [ "$STATE" = yes ]; then
 echo ACTION=ENABLE_AUTOSTART_EXISTING_DEFAULT
 if timeout 15s virsh -c "$URI" net-autostart default >"$TMP/autostart.out" 2>"$TMP/autostart.err"; then
  echo NET_AUTOSTART=PASS
 else
  echo NET_AUTOSTART=FAILED
  tail -n 5 "$TMP/autostart.err" | cut -c1-170
 fi
 echo FINAL_INFO_BEGIN
 inspect
 echo FINAL_INFO_END
 AUTOSTART="$(awk -F: '$1=="Autostart" {gsub(/[ \t\r]/,"",$2);print tolower($2)}' "$TMP/info" | tail -n1)"
 if [ "$STATE" = yes ] && [ "$AUTOSTART" = yes ] && ip -o -4 addr show dev virbr0 2>/dev/null | grep -q '192.168.122.1/24'; then
  echo RESULT=DEFAULT_NAT_ACTIVE_AUTOSTART_PASS
 else
  echo RESULT=NETWORK_PARTIAL_REVIEW_REQUIRED
 fi
else
 echo NETWORK_JOURNAL_BEGIN
 journalctl --no-pager -u virtnetworkd -u libvirtd -n 25 2>/dev/null | grep -Ei 'dnsmasq|network|default|error|failed|virbr|firewall' | tail -n 12 | cut -c1-200 || true
 echo NETWORK_JOURNAL_END
 echo RESULT=DEFAULT_NAT_NOT_ACTIVE_REVIEW_LOGS
fi
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$OUT"
exit 0
