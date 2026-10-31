#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
VM=kmj-cloudos-kvm-test
URI=qemu:///system
DOMAIN=kmj-cloudos-lifecycle-smoke-20261031
test "$(hostname -s)" = "$VM" || { echo HOST_CHECK=FAILED; exit 2; }
test "$(id -u)" -eq 0 || { echo ROOT_REQUIRED=YES; exit 2; }
test -c /dev/kvm || { echo KVM_DEVICE=ABSENT; exit 2; }
command -v virsh >/dev/null
command -v qemu-system-x86_64 >/dev/null
KERNEL="/boot/vmlinuz-$(uname -r)"
INITRD="/boot/initrd.img-$(uname -r)"
test -r "$KERNEL" && test -r "$INITRD" || { echo KERNEL_INITRD=NOT_FOUND; exit 2; }
TMP="$(mktemp -d /tmp/kmj-cloudos-virsh.XXXXXXXX)"
OWNED=no
cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$OWNED" = yes ]; then
    echo 'CLEANUP=CHECK_OWNED_DOMAIN'
    if timeout 15s virsh -c "$URI" dominfo "$DOMAIN" >/dev/null 2>&1; then
      timeout 20s virsh -c "$URI" destroy "$DOMAIN" >/dev/null 2>&1 || echo 'CLEANUP_DESTROY=FAILED_REVIEW'
    fi
  fi
  rm -rf -- "$TMP"
  exit "$rc"
}
trap cleanup EXIT
echo KMJ_CLOUDOS_SAFE_LIBVIRT_LIFECYCLE_V2
echo TARGET=kmj-cloudos-kvm-test
echo SCOPE=ONE_TRANSIENT_DOMAIN_NO_DISK_NO_NETWORK
echo 'OTHER_DOMAINS=NEVER_MODIFIED'
if timeout 10s virsh -c "$URI" dominfo "$DOMAIN" >/dev/null 2>&1; then
  echo DOMAIN_NAME_ALREADY_EXISTS=STOP
  exit 3
fi
if ! timeout 12s virsh -c "$URI" list --all --name >"$TMP/before" 2>"$TMP/error"; then
  echo LIBVIRT_ENUMERATION=FAILED
  tail -n 4 "$TMP/error" | cut -c1-160
  exit 3
fi
BEFORE="$(grep -c . "$TMP/before" || true)"
echo "EXISTING_DOMAIN_COUNT=$BEFORE"
if [ "$BEFORE" -ne 0 ]; then
  echo ABORT=NONEMPTY_EXISTING_DOMAIN_INVENTORY
  exit 3
fi
cat >"$TMP/guest.xml" <<EOF_XML
<domain type='kvm'>
  <name>$DOMAIN</name>
  <memory unit='MiB'>768</memory>
  <currentMemory unit='MiB'>768</currentMemory>
  <vcpu placement='static'>1</vcpu>
  <os>
    <type arch='x86_64'>hvm</type>
    <kernel>$KERNEL</kernel>
    <initrd>$INITRD</initrd>
    <cmdline>console=ttyS0 rdinit=/bin/sh panic=-1</cmdline>
  </os>
  <cpu mode='host-passthrough' check='none'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>destroy</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <serial type='pty'><target port='0'/></serial>
    <console type='pty'><target type='serial' port='0'/></console>
  </devices>
</domain>
EOF_XML
python3 - "$TMP/guest.xml" "$DOMAIN" <<'PY'
import sys
from xml.etree import ElementTree as ET
root=ET.parse(sys.argv[1]).getroot()
assert root.tag=='domain' and root.attrib.get('type')=='kvm'
assert root.findtext('name')==sys.argv[2]
for p in ('./devices/disk','./devices/interface','./devices/hostdev','./devices/filesystem'):
    assert root.find(p) is None, p
print('XML_ISOLATION=PASS')
PY
echo ACTION=CREATE_TRANSIENT
if ! timeout 35s virsh -c "$URI" create "$TMP/guest.xml" --validate >"$TMP/create.out" 2>"$TMP/create.err"; then
  if timeout 8s virsh -c "$URI" dominfo "$DOMAIN" >/dev/null 2>&1; then OWNED=yes; fi
  echo CREATE=FAILED
  tail -n 8 "$TMP/create.err" | cut -c1-170
  exit 4
fi
OWNED=yes
echo CREATE=PASS
STATE="$(timeout 12s virsh -c "$URI" domstate "$DOMAIN" 2>/dev/null || echo UNKNOWN)"
echo "DOMAIN_STATE=$STATE"
if [ "$STATE" != running ]; then
  echo RESULT=DOMAIN_NOT_RUNNING
  exit 5
fi
timeout 10s virsh -c "$URI" dumpxml "$DOMAIN" > "$TMP/live.xml"
python3 - "$TMP/live.xml" "$DOMAIN" <<'PY'
import sys
from xml.etree import ElementTree as ET
root=ET.parse(sys.argv[1]).getroot()
assert root.attrib.get('type')=='kvm' and root.findtext('name')==sys.argv[2]
for p in ('./devices/disk','./devices/interface','./devices/hostdev','./devices/filesystem'):
    assert root.find(p) is None, p
print('LIVE_GUEST_ISOLATION=PASS')
PY
echo ACTION=DESTROY_ONLY_CREATED_DOMAIN
if ! timeout 20s virsh -c "$URI" destroy "$DOMAIN" >"$TMP/destroy.out" 2>"$TMP/destroy.err"; then
  echo DESTROY=FAILED
  tail -n 5 "$TMP/destroy.err" | cut -c1-170
  exit 6
fi
echo DESTROY=PASS
if timeout 8s virsh -c "$URI" dominfo "$DOMAIN" >/dev/null 2>&1; then
  echo CLEANUP=STILL_REGISTERED
  exit 6
fi
OWNED=no
echo CLEANUP=PASS
if ! timeout 12s virsh -c "$URI" list --all --name > "$TMP/after"; then
  echo POST_INVENTORY=FAILED
  exit 6
fi
AFTER="$(grep -c . "$TMP/after" || true)"
echo "FINAL_DOMAIN_COUNT=$AFTER"
if [ "$AFTER" -ne "$BEFORE" ]; then
  echo RESULT=DOMAIN_INVENTORY_CHANGED
  exit 7
fi
echo RESULT=SAFE_LIBVIRT_CREATE_RUN_DESTROY_PASS
echo RECEIPT_COMPLETE=YES
