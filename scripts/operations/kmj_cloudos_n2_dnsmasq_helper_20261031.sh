#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ACTION="$1"
STAGE=/home/info_kmjtechno_com/kmj_n2_dnsmasq_20261031
URI=qemu:///system
case "$ACTION" in inspect|install|network) ;; *) echo INVALID_ACTION; exit 2;; esac
test "$(id -u)" = 0
test "$(hostname -s)" = kmj-cloudos-kvm-test
test "$(dpkg --print-architecture)" = amd64
test -c /dev/kvm
n="$(timeout 12s virsh -c "$URI" list --all --name | grep -c . || true)"
echo KMJ_N2_DNSMASQ_OFFLINE_HELPER_V1
echo "ACTION=$ACTION"
echo "DOMAINS=$n"
test "$n" = 0 || { echo BLOCKED=EXISTING_GUESTS; exit 3; }
plan() {
 python3 - <<'PY'
import subprocess,re
cmd=['apt-get','-s','-o','Debug::NoLocking=1','--no-install-recommends','install','dnsmasq-base']
p=subprocess.run(cmd,text=True,capture_output=True,timeout=25)
if p.returncode:
  print('BLOCKED=APT_SIMULATION_FAILED')
  print('APT_ERROR='+p.stderr.strip().split('\n')[-1][:140])
  raise SystemExit(4)
lines=p.stdout.splitlines()
if any(l.startswith(('Remv ','Purg ')) for l in lines):
  print('BLOCKED=APT_REMOVALS')
  raise SystemExit(4)
items=[]
for line in lines:
 if not line.startswith('Inst '): continue
 m=re.match(r'^Inst ([A-Za-z0-9.+-]+)(?: \[([^\]]+)\])? \(([^ )]+) ',line)
 if not m:
  print('BLOCKED=UNPARSEABLE_INSTALL_PLAN')
  raise SystemExit(4)
 pkg,old,version=m.groups()
 if old:
  print('BLOCKED=APT_UPGRADE_'+pkg)
  raise SystemExit(4)
 meta=subprocess.run(['apt-cache','show',pkg],text=True,capture_output=True,timeout=15)
 found=None
 for block in meta.stdout.split('\n\n'):
  f={}
  for l in block.splitlines():
   if ': ' in l and not l.startswith(' '):
    k,v=l.split(': ',1);f[k]=v
  if f.get('Package')==pkg and f.get('Version')==version and f.get('Architecture')=='amd64':
   found=f;break
 if not found:
  print('BLOCKED=MISSING_APT_METADATA_'+pkg)
  raise SystemExit(4)
 sha=found.get('SHA256','')
 path=found.get('Filename','')
 if not re.fullmatch('[0-9a-f]{64}',sha) or not re.fullmatch(r'pool/[A-Za-z0-9_+./%-]+',path) or '..' in path:
  print('BLOCKED=UNTRUSTED_APT_METADATA_'+pkg)
  raise SystemExit(4)
 items.append((pkg,version,sha,path))
if not any(item[0]=='dnsmasq-base' for item in items) and not __import__('os').path.isfile('/usr/sbin/dnsmasq'):
 print('BLOCKED=DNSMASQ_NOT_INSTALLED_BUT_NOT_PLANNED')
 raise SystemExit(4)
if len(items)>12:
 print('BLOCKED=EXCESSIVE_DEPENDENCIES')
 raise SystemExit(4)
print('APT_SIMULATION=PASS')
print('PLANNED_COUNT='+str(len(items)))
for item in items: print('PACKAGE|'+'|'.join(item))
PY
}
if [ "$ACTION" = inspect ]; then
 plan
 echo RESULT=DNSMASQ_PACKAGE_PLAN_READY
 exit 0
fi
if [ "$ACTION" = install ]; then
 test -d "$STAGE" && test ! -L "$STAGE" || { echo UNSAFE_STAGING_DIRECTORY; exit 5; }
 PLAN="$(plan)"
 printf '%s\n' "$PLAN"
 count="$(printf '%s\n' "$PLAN" | sed -n 's/^PLANNED_COUNT=//p')"
 test -n "$count"
 if [ "$count" -eq 0 ]; then
   test -x /usr/sbin/dnsmasq
   echo DNSMASQ=ALREADY_READY
   exit 0
 fi
 actual="$(find "$STAGE" -mindepth 1 -maxdepth 1 -name '*.deb' -type f | wc -l)"
 test "$actual" -eq "$count" || { echo PACKAGE_COUNT_MISMATCH; exit 5; }
 while IFS='|' read -r marker pkg version sha rel; do
   [ "$marker" = PACKAGE ] || continue
   f="$STAGE/$(basename "$rel")"
   test -f "$f" && test ! -L "$f" || { echo MISSING_PACKAGE_FILE; exit 5; }
   echo "$sha  $f" | sha256sum -c -
   test "$(dpkg-deb -f "$f" Package)" = "$pkg"
   test "$(dpkg-deb -f "$f" Version)" = "$version"
   test "$(dpkg-deb -f "$f" Architecture)" = amd64
 done <<< "$PLAN"
 LOG="$(mktemp /tmp/kmj-dnsmasq-dpkg.XXXXXXXX)"
 echo OFFLINE_DPKG_INSTALL=START
 if timeout --signal=TERM --kill-after=5s 100s dpkg -i "$STAGE"/*.deb >"$LOG" 2>&1; then
   echo OFFLINE_DPKG_INSTALL=PASS
 else
   echo OFFLINE_DPKG_INSTALL=FAILED
   tail -n 12 "$LOG" | cut -c1-165
   rm -f "$LOG"
   exit 6
 fi
 rm -f "$LOG"
 test -x /usr/sbin/dnsmasq || { echo DNSMASQ=MISSING_AFTER_INSTALL; exit 6; }
 echo DNSMASQ=READY
 /usr/sbin/dnsmasq --version | head -n1
 echo RESULT=DNSMASQ_PACKAGE_READY
 exit 0
fi
test -x /usr/sbin/dnsmasq
D="$(mktemp -d /tmp/kmj-n2-dns-net.XXXXXXXX)"
trap 'rm -rf -- "$D"' EXIT
timeout 10s virsh -c "$URI" net-dumpxml default > "$D/net.xml"
ip -j -4 route show > "$D/routes.json"
python3 - "$D/net.xml" "$D/routes.json" <<'PY'
import ipaddress,json,sys
from xml.etree import ElementTree as E
x=E.parse(sys.argv[1]).getroot()
assert x.tag=='network' and x.findtext('name')=='default'
f=x.find('forward')
assert f is not None and f.get('mode')=='nat'
assert len(x.findall('forward'))==1 and not f.findall('interface')
b=x.find('bridge')
assert b is not None and b.get('name')=='virbr0'
ips=x.findall('ip')
assert len(ips)==1 and ips[0].get('address')=='192.168.122.1' and ips[0].get('netmask')=='255.255.255.0'
target=ipaddress.ip_network('192.168.122.0/24')
for row in json.load(open(sys.argv[2])):
 if row.get('dst') in (None,'default') or row.get('dev')=='virbr0':continue
 try: route=ipaddress.ip_network(row['dst'],strict=False)
 except (KeyError,ValueError):continue
 assert not target.overlaps(route),'HOST_ROUTE_OVERLAP'
print('NAT_CONFIG_GUARD=PASS')
PY
if timeout 10s virsh -c "$URI" net-info default | grep -Eq '^Active:[[:space:]]+yes'; then
 echo DEFAULT_NETWORK=ALREADY_ACTIVE
else
 echo DEFAULT_NETWORK=STARTING
 if timeout 35s virsh -c "$URI" net-start default >"$D/start.out" 2>"$D/start.err"; then
  echo DEFAULT_NETWORK_START=PASS
 else
  echo DEFAULT_NETWORK_START=FAILED
  tail -n 8 "$D/start.err" | cut -c1-180
  exit 7
 fi
fi
timeout 12s virsh -c "$URI" net-info default | grep -Eq '^Active:[[:space:]]+yes'
echo DEFAULT_NETWORK_ACTIVE=PASS
timeout 10s virsh -c "$URI" net-autostart default >/dev/null
echo DEFAULT_NETWORK_AUTOSTART=PASS
echo RESULT=N2_DNSMASQ_AND_LIBVIRT_NAT_READY
echo RECEIPT_COMPLETE=YES
