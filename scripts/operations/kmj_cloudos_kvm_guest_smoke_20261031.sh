#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
test "$(hostname -s)" = "kmj-cloudos-kvm-test"
test -c /dev/kvm
command -v qemu-system-x86_64 >/dev/null
command -v virsh >/dev/null
tmp="$(mktemp -d /tmp/kmj-cloudos-kvm-smoke.XXXXXXXX)"
pid=""
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for i in 1 2 3 4 5; do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf -- "$tmp"
}
trap cleanup EXIT
echo KMJ_CLOUDOS_NESTED_KVM_GUEST_SMOKE_V1
echo HOST=kmj-cloudos-kvm-test
echo SCOPE=EPHEMERAL_QEMU_NO_GUEST_DISK_NO_NETWORK
echo EXISTING_LIBVIRT_GUESTS=UNTOUCHED
echo 'KVM_DEVICE=PRESENT'
echo "VMX_COUNT=$(grep -cw vmx /proc/cpuinfo || true)"
echo "QEMU_VERSION=$(qemu-system-x86_64 --version | head -n 1 | cut -c1-110)"
if timeout 8s virsh -c qemu:///system list --all --name >"$tmp/virsh.out" 2>"$tmp/virsh.err"; then
 echo "LIBVIRT_CONNECTION=PASS"
 echo "EXISTING_DOMAIN_COUNT=$(grep -c . "$tmp/virsh.out" || true)"
else echo LIBVIRT_CONNECTION=NOT_READY; fi
kernel="/boot/vmlinuz-$(uname -r)"
initrd="/boot/initrd.img-$(uname -r)"
if [ ! -r "$kernel" ] || [ ! -r "$initrd" ]; then
 echo KERNEL_INITRD=UNAVAILABLE
 echo RESULT=BLOCKED_GUEST_KERNEL_MISSING
 echo RECEIPT_COMPLETE=YES
 exit 0
fi
echo KERNEL_INITRD=FOUND
echo ACTION=START_ISOLATED_GUEST_KERNEL
qemu-system-x86_64 -machine pc,accel=kvm -cpu host -smp 1 -m 768 \
  -no-user-config -nodefaults -display none -monitor none \
  -nic none -no-reboot -kernel "$kernel" -initrd "$initrd" \
  -append 'console=ttyS0 rdinit=/bin/sh panic=-1' \
  -serial "file:$tmp/serial.log" >"$tmp/qemu.out" 2>"$tmp/qemu.err" &
pid=$!
echo QEMU_START_REQUESTED=YES
boot=no
for i in $(seq 1 35); do
  if [ -f "$tmp/serial.log" ] && grep -q 'Linux version ' "$tmp/serial.log"; then boot=yes; break; fi
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$boot" = yes ] && kill -0 "$pid" 2>/dev/null; then
  echo GUEST_KERNEL_BOOT=PASS
  echo QEMU_KVM_PROCESS=RUNNING
  echo RESULT=NESTED_KVM_BOOT_SMOKE_PASS
else
  echo GUEST_KERNEL_BOOT=UNVERIFIED
  echo QEMU_LOG_TAIL_BEGIN
  tail -n 7 "$tmp/qemu.err" | cut -c1-180 || true
  if [ -f "$tmp/serial.log" ]; then tail -n 7 "$tmp/serial.log" | cut -c1-180; fi
  echo QEMU_LOG_TAIL_END
  echo RESULT=NESTED_KVM_BOOT_SMOKE_BLOCKED
fi
echo ACTION=TERMINATE_DISPOSABLE_GUEST
echo RECEIPT_COMPLETE=YES
