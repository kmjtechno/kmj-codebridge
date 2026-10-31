#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
test "$(hostname -s)" = "kmj-cloudos-kvm-test"
test -c /dev/kvm
command -v virsh >/dev/null
command -v qemu-system-x86_64 >/dev/null
base=/boot
kernel="$base/vmlinuz-$(uname -r)"
initrd="$base/initrd.img-$(uname -r)"
test -r "$kernel" && test -r "$initrd"
dir="$(mktemp -d /tmp/kmj-libvirt-lifecycle.XXXXXXXX)"
domain="kmj-cloudos-smoke-$(date -u +%Y%m%d%H%M%S)-$$"
owned=0
cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$owned" = 1 ] && virsh -c qemu:///system dominfo "$domain" >/dev/null 2>&1; then
    echo "EMERGENCY_CLEANUP=OWNED_GUEST_ONLY"
    virsh -c qemu:///system destroy "$domain" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$dir"
  exit "$rc"
}
trap cleanup EXIT
echo KMJ_CLOUDOS_LIBVIRT_TRANSIENT_LIFECYCLE_V1
echo HOST=kmj-cloudos-kvm-test
echo SCOPE=OWNED_TRANSIENT_GUEST_NO_DISK_NO_NIC
echo ROOT_DISKS=UNCHANGED
echo EXISTING_GUESTS=UNTOUCHED
if virsh -c qemu:///system dominfo "$domain" >/dev/null 2>&1; then
  echo "PRECHECK=DOMAIN_NAME_COLLISION"
  exit 3
fi
before="$(virsh -c qemu:///system list --all --name | sed '/^$/d' | wc -l)"
echo "EXISTING_DOMAINS_BEFORE=$before"
cat > "$dir/guest.xml" <<XML
<domain type='kvm'>
  <name>$domain</name>
  <memory unit='MiB'>768</memory>
  <currentMemory unit='MiB'>768</currentMemory>
  <vcpu placement='static'>1</vcpu>
  <os>
    <type arch='x86_64' machine='pc'>hvm</type>
    <kernel>$kernel</kernel>
    <initrd>$initrd</initrd>
    <cmdline>console=ttyS0 rdinit=/bin/sh panic=-1</cmdline>
  </os>
  <cpu mode='host-passthrough' check='none'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>destroy</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <serial type='pty'>
      <target port='0'/>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>
  </devices>
</domain>
XML
python3 - "$dir/guest.xml" "$domain" <<'PY'
from xml.etree import ElementTree as E
import sys
x=E.parse(sys.argv[1]).getroot()
assert x.tag == 'domain' and x.get('type') == 'kvm'
assert x.findtext('name') == sys.argv[2]
assert x.find('./devices/disk') is None
assert x.find('./devices/interface') is None
assert x.find('./devices/hostdev') is None
assert x.find('./devices/filesystem') is None
assert x.find('./os/kernel') is not None
print('XML_NO_DISK_NO_NIC=PASS')
PY
echo "ACTION=VIRSH_CREATE_TRANSIENT"
if ! virsh -c qemu:///system create "$dir/guest.xml" --validate >"$dir/create.out" 2>"$dir/create.err"; then
  if virsh -c qemu:///system dominfo "$domain" >/dev/null 2>&1; then owned=1; fi
  echo "VIRSH_CREATE=FAILED"
  tail -n 7 "$dir/create.err" | cut -c1-170
  exit 4
fi
owned=1
echo "VIRSH_CREATE=PASS"
running=no
for i in 1 2 3 4 5 6; do
  state="$(virsh -c qemu:///system domstate "$domain" 2>/dev/null || echo unknown)"
  if [ "$state" = running ]; then running=yes; break; fi
  sleep 1
done
echo "VIRSH_RUNNING=$running"
if [ "$running" != yes ]; then
  echo "RESULT=LIBVIRT_START_BLOCKED"
  exit 5
fi
virsh -c qemu:///system dumpxml "$domain" > "$dir/runtime.xml"
python3 - "$dir/runtime.xml" "$domain" <<'PY'
from xml.etree import ElementTree as E
import sys
x=E.parse(sys.argv[1]).getroot()
assert x.get('type')=='kvm' and x.findtext('name')==sys.argv[2]
assert not x.findall('./devices/disk'), 'Unexpected attached disk'
assert not x.findall('./devices/interface'), 'Unexpected network interface'
assert not x.findall('./devices/hostdev'), 'Unexpected host device'
print('LIVE_DOMAIN_ISOLATION=PASS')
PY
if virsh -c qemu:///system dominfo "$domain" | grep -q '^Persistent: *no'; then
  echo "TRANSIENT_DOMAIN=PASS"
else
  echo "TRANSIENT_DOMAIN=UNVERIFIED"
  exit 6
fi
echo "ACTION=DESTROY_OWNED_TRANSIENT_GUEST"
virsh -c qemu:///system destroy "$domain" >/dev/null
if virsh -c qemu:///system dominfo "$domain" >/dev/null 2>&1; then
  echo "DOMAIN_CLEANUP=FAILED"
  exit 7
fi
owned=0
echo "DOMAIN_CLEANUP=PASS"
after="$(virsh -c qemu:///system list --all --name | sed '/^$/d' | wc -l)"
echo "EXISTING_DOMAINS_AFTER=$after"
if [ "$before" -ne "$after" ]; then
  echo "DOMAIN_COUNT_CHECK=CHANGED_REVIEW_REQUIRED"
  exit 8
fi
echo "DOMAIN_COUNT_CHECK=PASS"
echo "RESULT=LIBVIRT_TRANSIENT_CREATE_RUN_DESTROY_PASS"
echo "RECEIPT_COMPLETE=YES"
