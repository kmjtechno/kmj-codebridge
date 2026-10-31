#!/usr/bin/env bash
# KMJ CloudOS Noble / QGA integration feasibility inventory.
# Read-only: no GCE config edits, guest creation, package installation or image download.
set -Eeuo pipefail
umask 077
P=kmj-techno
Z=us-central1-a
V=kmj-cloudos-kvm-test
R="$HOME/kmj_cloudos_n2_image_qga_preflight_20261031.txt"
T="$(mktemp -d)"
trap 'rm -rf -- "$T"' EXIT
{
  echo 'KMJ_CLOUDOS_N2_IMAGE_QGA_PREFLIGHT_V1'
  echo 'SCOPE=READ_ONLY'
  echo "TARGET=$P/$Z/$V"
  gcloud compute instances describe "$V" --project="$P" --zone="$Z" --format=json > "$T/gce.json"
  python3 - "$T/gce.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x.get('name')=='kmj-cloudos-kvm-test'
assert x.get('zone','').endswith('/us-central1-a')
assert x.get('status')=='RUNNING'
assert x.get('machineType','').endswith('/n2-standard-2')
assert x.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
print('GCE_TARGET_AND_NESTED=PASS')
PY
  for bin in cloud-localds xorriso genisoimage mkisofs; do
    if command -v "$bin" >/dev/null 2>&1; then echo "CLOUDSHELL_TOOL_PRESENT=$bin"; else echo "CLOUDSHELL_TOOL_MISSING=$bin"; fi
  done
  echo 'OFFICIAL_IMAGE=UBUNTU_NOBLE_QCOW2'
  if curl -fLSs --retry 2 --connect-timeout 10 --max-time 45 \
    --proto '=https' --proto-redir '=https' \
    https://cloud-images.ubuntu.com/noble/current/SHA256SUMS -o "$T/SHA256SUMS"; then
    if grep -E '(^|[ *])noble-server-cloudimg-amd64[.]img$' "$T/SHA256SUMS" > "$T/target.sha"; then
      cat "$T/target.sha" | sed 's/^/OFFICIAL_SHA256_ENTRY=/'
      echo 'OFFICIAL_IMAGE_SHA256SUMS=AVAILABLE'
    else echo 'OFFICIAL_IMAGE_SHA256SUMS=ENTRY_MISSING'; fi
  else echo 'OFFICIAL_IMAGE_SHA256SUMS=UNAVAILABLE'; fi
  if curl -fLSs --retry 2 --connect-timeout 10 --max-time 45 \
    --proto '=https' --proto-redir '=https' \
    https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.manifest -o "$T/manifest"; then
    if grep -q '^qemu-guest-agent[[:space:]]' "$T/manifest"; then
      echo 'BASE_IMAGE_QGA_PACKAGE=PRESENT'
    else echo 'BASE_IMAGE_QGA_PACKAGE=ABSENT_REQUIRES_OFFLINE_PREPARATION'; fi
    echo 'OFFICIAL_PACKAGE_MANIFEST=READ'
  else echo 'OFFICIAL_PACKAGE_MANIFEST=UNAVAILABLE'; fi
  printf '%s\n' 'GUEST_HOST_INVENTORY_BEGIN'
  if timeout --signal=TERM --kill-after=5s 65s gcloud compute ssh "$V" \
    --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
    --ssh-flag='-oBatchMode=yes' --ssh-flag='-oConnectTimeout=12' \
    --command="sudo -n bash -lc 'set -u; test \"\$(hostname -s)\" = kmj-cloudos-kvm-test || exit 2; echo HOST=VERIFIED; echo FREE_ROOT_MIB=\$(df -Pm / | awk \"NR==2{print \\\$4}\"); echo KVM=\$(test -c /dev/kvm && echo PRESENT || echo ABSENT); for t in qemu-img cloud-localds xorriso genisoimage mkisofs virsh; do if command -v \"\$t\" >/dev/null; then echo TOOL_PRESENT=\$t; else echo TOOL_MISSING=\$t; fi; done; for p in /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_VARS_4M.fd; do if test -r \"\$p\"; then echo OVMF_PRESENT=\$p; else echo OVMF_MISSING=\$p; fi; done; if timeout 8s virsh -c qemu:///system net-info default; then echo LIBVIRT_DEFAULT_INFO=PASS; else echo LIBVIRT_DEFAULT_INFO=FAIL; fi; echo DOMAINS_BEGIN; timeout 8s virsh -c qemu:///system list --all --name; echo DOMAINS_END; for p in /var/lib/libvirt/images/kmj-cloudos-ci/base.qcow2 /var/lib/libvirt/images/kmj-cloudos-ci/qga-prepared.qcow2; do if test -f \"\$p\" && test ! -L \"\$p\"; then echo IMAGE_PRESENT=\$p; else echo IMAGE_NOT_PRESENT=\$p; fi; done; echo QGA_PACKAGE_APT_SIMULATION_BEGIN; timeout 12s apt-get -s --no-install-recommends install qemu-guest-agent 2>&1 | tail -n 7; echo QGA_PACKAGE_APT_SIMULATION_END; echo HOST_INVENTORY_COMPLETE=YES'" \
    >"$T/guest.out" 2>"$T/guest.err"; then
    cat "$T/guest.out" | tail -n 65
    echo 'GUEST_HOST_INVENTORY=PASS'
  else
    echo 'GUEST_HOST_INVENTORY=SSH_BLOCKED'
    grep -Ei '4003|error|failed|denied|timed out' "$T/guest.err" | tail -n 5 | cut -c1-160 || true
  fi
  echo 'GUEST_HOST_INVENTORY_END'
  echo 'HOST_HAS_NO_PUBLIC_OUTBOUND_ASSUMED=DO_NOT_ASSUME_EGRESS'
  echo 'CLOUDOS_PROVIDER_E2E=NOT_YET_TESTED'
  echo 'RECEIPT_COMPLETE=YES'
} 2>&1 | tee "$R"
echo "RECEIPT_PATH=$R"
