#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
TAG=kmj-cloudos-iap-ssh-20261031
RULE=kmj-cloudos-iap-ssh-20261031
OUT="$HOME/kmj_cloudos_iap_ssh_repair_20261031.txt"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
{
  echo 'KMJ_CLOUDOS_IAP_SSH_REPAIR_V1'
  echo 'SCOPE=EXISTING_TEST_VM_ONLY'
  echo "VM=$VM"
  echo 'IAP_CIDR=35.235.240.0/20'
  echo 'SSH_PORT=22'
  echo 'PUBLIC_SSH_RULE=NOT_CREATED'
  gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format=json >"$WORK/vm.json"
  gcloud compute instances list --project="$PROJECT" --format=json >"$WORK/vms.json"
  read -r NETWORK TAG_PRESENT < <(python3 - "$WORK/vm.json" "$WORK/vms.json" "$TAG" <<'PY'
import json,sys,re
vm=json.load(open(sys.argv[1]))
vms=json.load(open(sys.argv[2]))
tag=sys.argv[3]
assert vm.get('name')=='kmj-cloudos-kvm-test', 'Wrong VM'
assert vm.get('zone','').endswith('/us-central1-a'), 'Wrong zone'
assert vm.get('status')=='RUNNING', 'VM not running'
assert vm.get('machineType','').endswith('/n2-standard-2'), 'Unexpected machine'
assert vm.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True, 'Nested virtualization disabled'
nics=vm.get('networkInterfaces',[])
assert len(nics)==1, 'Multiple NICs: manual review'
net=nics[0]['network']
m=re.fullmatch(r'https://www.googleapis.com/compute/v1/projects/kmj-techno/global/networks/([a-z][-a-z0-9]*)',net)
assert m, 'Unexpected project/VPC (shared VPC requires review)'
others=[x.get('name') for x in vms if x.get('name')!='kmj-cloudos-kvm-test' and tag in x.get('tags',{}).get('items',[])]
assert not others,'Proposed target tag already used on other VMs'
print(m.group(1), 'yes' if tag in vm.get('tags',{}).get('items',[]) else 'no')
PY
)
  test -n "$NETWORK"
  echo 'VM_PREFLIGHT=PASS'
  echo "NETWORK=$NETWORK"
  if gcloud compute firewall-rules describe "$RULE" --project="$PROJECT" --format=json >"$WORK/rule.json" 2>/dev/null; then
    if ! python3 - "$WORK/rule.json" "$NETWORK" "$TAG" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
net=sys.argv[2]; tag=sys.argv[3]
assert x.get('network','').endswith('/networks/'+net)
assert x.get('direction')=='INGRESS'
assert not x.get('disabled',False)
assert x.get('priority',1000)==900
assert x.get('sourceRanges')==['35.235.240.0/20']
assert x.get('targetTags')==[tag]
assert x.get('allowed')==[{'IPProtocol':'tcp','ports':['22']}]
PY
    then
      echo 'FIREWALL_EXISTING_RULE=UNEXPECTED_STOP'
      exit 3
    fi
    echo 'FIREWALL_RULE=EXISTING_VERIFIED'
  else
    echo 'FIREWALL_RULE=CREATE_IAP_ONLY'
    gcloud compute firewall-rules create "$RULE" --project="$PROJECT" \
      --network="$NETWORK" --direction=INGRESS --priority=900 \
      --allow=tcp:22 --source-ranges=35.235.240.0/20 \
      --target-tags="$TAG" --quiet >"$WORK/firewall.txt"
    echo 'FIREWALL_RULE=CREATED'
  fi
  if [ "$TAG_PRESENT" = no ]; then
    gcloud compute instances add-tags "$VM" --project="$PROJECT" --zone="$ZONE" --tags="$TAG" --quiet >"$WORK/tag.txt"
    echo 'TEST_VM_NETWORK_TAG=ADDED'
  else
    echo 'TEST_VM_NETWORK_TAG=ALREADY_PRESENT'
  fi
  echo 'GUEST_SSH_PROBE=START'
  ok=no
  for attempt in 1 2 3; do
    if timeout 65s gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" \
      --tunnel-through-iap --quiet \
      --ssh-flag='-oBatchMode=yes' --ssh-flag='-oConnectTimeout=15' \
      --command="bash -lc 'echo SSH_CONNECT=PASS; echo VMX_COUNT=\$(grep -cw vmx /proc/cpuinfo || true); if test -c /dev/kvm; then echo KVM_DEVICE=PRESENT; else echo KVM_DEVICE=ABSENT; fi; command -v virsh >/dev/null 2>&1 && echo VIRSH=PRESENT || echo VIRSH=MISSING; command -v qemu-system-x86_64 >/dev/null 2>&1 && echo QEMU=PRESENT || echo QEMU=MISSING'" >"$WORK/ssh.out" 2>"$WORK/ssh.err"; then
      echo 'GUEST_SSH_PROBE=PASS'
      grep -E '^(SSH_CONNECT|VMX_COUNT|KVM_DEVICE|VIRSH|QEMU)=' "$WORK/ssh.out" || true
      ok=yes
      break
    fi
    echo "SSH_ATTEMPT_$attempt=FAILED"
    [ "$attempt" -lt 3 ] && sleep 8
  done
  if [ "$ok" = no ]; then
    echo 'GUEST_SSH_PROBE=STILL_BLOCKED'
    grep -Ei '4003|error|denied|timed out|failed|unreachable|refused' "$WORK/ssh.err" | tail -n 5 | cut -c1-190 || true
    echo 'NEXT=CHECK_GUEST_SSHD_OR_FIREWALL_POLICIES'
  elif grep -qx 'KVM_DEVICE=PRESENT' "$WORK/ssh.out" && grep -Eq '^VMX_COUNT=[1-9][0-9]*$' "$WORK/ssh.out"; then
    echo 'RESULT=KVM_DEVICE_READY_GUEST_LIFECYCLE_UNTESTED'
  else
    echo 'RESULT=SSH_FIXED_GUEST_KVM_PENDING'
  fi
  echo 'RECEIPT_COMPLETE=YES'
} 2>&1 | tee "$OUT"
echo "RECEIPT_PATH=$OUT"