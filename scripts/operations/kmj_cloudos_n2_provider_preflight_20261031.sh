#!/usr/bin/env bash
set -u
VM=kmj-cloudos-kvm-test
OUT="$HOME/kmj_cloudos_n2_provider_preflight_20261031.txt"
{
 echo "KMJ_N2_COMPUTE_PREFLIGHT_V1"
 echo "SCOPE=READ_ONLY"
 echo "HOST=$(hostname -s)"
 if [ "$(hostname -s)" != "$VM" ]; then echo "RESULT=WRONG_HOST"; exit 2; fi
 if [ -c /dev/kvm ]; then echo "KVM_DEVICE=PRESENT"; else echo "KVM_DEVICE=ABSENT"; fi
 echo "VMX_COUNT=$(grep -cw vmx /proc/cpuinfo || true)"
 echo "ROOT_FREE_KIB=$(df -Pk / | awk 'NR==2 {print $4}')"
 for bin in virsh qemu-system-x86_64 qemu-img virt-install cloud-localds; do
   if command -v "$bin" >/dev/null 2>&1; then echo "TOOL_PRESENT=$bin"; else echo "TOOL_MISSING=$bin"; fi
 done
 if timeout 8s virsh -c qemu:///system list --all --name >/dev/null 2>&1; then
  echo LIBVIRT_CONNECT=PASS
  echo "DOMAINS=$(timeout 8s virsh -c qemu:///system list --all --name 2>/dev/null | grep -c . || true)"
  if timeout 8s virsh -c qemu:///system net-info default > /dev/null 2>&1; then
    echo "DEFAULT_NETWORK=DEFINED"
    if timeout 8s virsh -c qemu:///system net-info default | grep -Eq '^Active: *yes'; then echo "DEFAULT_NETWORK_ACTIVE=YES"; else echo "DEFAULT_NETWORK_ACTIVE=NO"; fi
  else echo "DEFAULT_NETWORK=ABSENT"; fi
 else echo LIBVIRT_CONNECT=BLOCKED; fi
 for p in qemu-guest-agent libvirt-daemon-system libvirt-clients qemu-utils; do
   if dpkg-query -W "$p" >/dev/null 2>&1; then echo "PACKAGE_INSTALLED=$p"; else echo "PACKAGE_NOT_INSTALLED=$p"; fi
 done
 if [ -d /var/lib/libvirt/images ]; then
   echo "IMAGE_FILES=$(find /var/lib/libvirt/images -maxdepth 1 -type f -name '*.qcow2' | wc -l)"
 else echo IMAGE_FILES_DIR=ABSENT; fi
 echo "CLOUDOS_AUTHENTICATED_CONNECTIVITY=NOT_VERIFIED"
 echo "GUEST_QGA_RESPONSE=NOT_VERIFIED"
 echo "RESULT=READ_ONLY_PREFLIGHT_COMPLETE"
} 2>&1 | tee "$OUT"
exit 0