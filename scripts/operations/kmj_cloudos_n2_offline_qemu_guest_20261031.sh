#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
test "$(id -u)" = 0
test "$(hostname -s)" = kmj-cloudos-kvm-test
test "$(dpkg --print-architecture)" = amd64
test -c /dev/kvm
URI=qemu:///system
VERSION=1:8.2.2+ds-0ubuntu1.18
DEB=qemu-utils_8.2.2+ds-0ubuntu1.18_amd64.deb
ACTION="$1"
case "$ACTION" in inspect|install|network) ;; *) echo INVALID_ACTION; exit 2;; esac
echo "KMJ_N2_OFFLINE_QEMU_HELPER_V1"
echo "ACTION=$ACTION"
echo "HOST=kmj-cloudos-kvm-test"
echo "SCOPE=EXISTING_HOST_ONLY"
timeout 12s virsh -c "$URI" list --all --name >/dev/null
COUNT="$(timeout 12s virsh -c "$URI" list --all --name | grep -c . || true)"
echo "GUEST_DOMAIN_COUNT=$COUNT"
test "$COUNT" = 0 || { echo BLOCKED=NONEMPTY_GUEST_INVENTORY; exit 3; }
if command -v qemu-img >/dev/null; then echo QEMU_IMG=PRESENT; else echo QEMU_IMG=MISSING; fi
if [ "$ACTION" = inspect ]; then
 python3 - "$VERSION" <<'PY'
import subprocess,sys,re
v=sys.argv[1]
data=subprocess.check_output(['apt-cache','show','qemu-utils'],text=True)
for block in data.split('\n\n'):
  f={}
  for line in block.splitlines():
    if ': ' in line and not line.startswith(' '):
      k,val=line.split(': ',1);f[k]=val
  if f.get('Package')=='qemu-utils' and f.get('Version')==v and f.get('Architecture')=='amd64':
    h=f.get('SHA256','')
    assert re.fullmatch('[a-f0-9]{64}',h),'APT_SHA256_MISSING'
    assert f.get('Filename','').endswith('/qemu-utils_8.2.2+ds-0ubuntu1.18_amd64.deb'),'PACKAGE_FILENAME_UNEXPECTED'
    print('DEB_SHA256='+h)
    print('DEB_FILE=qemu-utils_8.2.2+ds-0ubuntu1.18_amd64.deb')
    print('APT_METADATA=PASS')
    break
else: raise RuntimeError('APT_VERSION_NOT_FOUND')
PY
 echo 'RESULT=APT_METADATA_READY'
 exit 0
fi
if [ "$ACTION" = install ]; then
 PKG="$2"
 test "$PKG" = "/home/info_kmjtechno_com/$DEB"
 test -f "$PKG" && test ! -L "$PKG"
 EXPECTED="$(python3 - "$VERSION" <<'PY'
import subprocess,sys
v=sys.argv[1]
data=subprocess.check_output(['apt-cache','show','qemu-utils'],text=True)
for block in data.split('\n\n'):
 f={}
 for line in block.splitlines():
  if ': ' in line and not line.startswith(' '):
   k,val=line.split(': ',1);f[k]=val
 if f.get('Package')=='qemu-utils' and f.get('Version')==v and f.get('Architecture')=='amd64':
  print(f.get('SHA256',''));break
PY
)"
 echo "$EXPECTED  $PKG" | sha256sum -c -
 test "$(dpkg-deb -f "$PKG" Package)" = qemu-utils
 test "$(dpkg-deb -f "$PKG" Version)" = "$VERSION"
 test "$(dpkg-deb -f "$PKG" Architecture)" = amd64
 if ! command -v qemu-img >/dev/null; then
  echo 'REINSTALL=START'
  LOG="$(mktemp /tmp/kmj-qemu-install.XXXXXXXX)"
  if timeout --signal=TERM --kill-after=5s 90s dpkg -i "$PKG" >"$LOG" 2>&1; then
   echo REINSTALL=PASS
  else
   echo REINSTALL=FAILED
   tail -n 10 "$LOG" | cut -c1-160
   rm -f "$LOG"
   exit 5
  fi
  rm -f "$LOG"
 else
  echo REINSTALL=NOT_NEEDED
 fi
 command -v qemu-img >/dev/null
 echo QEMU_IMG=PASS
 qemu-img --version | head -n1
 echo RESULT=QEMU_IMG_READY
 exit 0
fi
test "$ACTION" = network
test "$(command -v qemu-img)" = /usr/bin/qemu-img
D="$(mktemp -d /tmp/kmj-n2-net.XXXXXXXX)"
trap 'rm -rf -- "$D"' EXIT
timeout 10s virsh -c "$URI" net-dumpxml default >"$D/net.xml"
ip -j -4 route show >"$D/routes.json"
python3 - "$D/net.xml" "$D/routes.json" <<'PY'
import ipaddress,json,sys
from xml.etree import ElementTree as ET
x=ET.parse(sys.argv[1]).getroot()
assert x.tag=='network' and x.findtext('name')=='default'
fw=x.find('forward')
assert fw is not None and fw.attrib.get('mode')=='nat'
assert len(x.findall('forward'))==1 and not fw.findall('interface')
b=x.find('bridge')
assert b is not None and b.attrib.get('name')=='virbr0'
ips=x.findall('ip')
assert len(ips)==1 and ips[0].get('address')=='192.168.122.1' and ips[0].get('netmask')=='255.255.255.0'
target=ipaddress.ip_network('192.168.122.0/24')
for o in json.load(open(sys.argv[2])):
  if o.get('dst') in (None,'default') or o.get('dev')=='virbr0':continue
  try: r=ipaddress.ip_network(o['dst'],strict=False)
  except (ValueError,KeyError):continue
  assert not target.overlaps(r),'HOST_ROUTE_OVERLAP'
print('NAT_NETWORK_GUARD=PASS')
PY
if timeout 10s virsh -c "$URI" net-info default | grep -Eq '^Active:[[:space:]]+yes'; then
 echo DEFAULT_NETWORK=ALREADY_ACTIVE
else
 echo DEFAULT_NETWORK=STARTING
 timeout 35s virsh -c "$URI" net-start default
fi
timeout 10s virsh -c "$URI" net-info default | grep -Eq '^Active:[[:space:]]+yes'
echo DEFAULT_NETWORK_ACTIVE=PASS
timeout 10s virsh -c "$URI" net-autostart default >/dev/null
echo DEFAULT_NETWORK_AUTOSTART=PASS
echo RESULT=QEMU_IMG_AND_DEFAULT_NETWORK_READY
echo RECEIPT_COMPLETE=YES
