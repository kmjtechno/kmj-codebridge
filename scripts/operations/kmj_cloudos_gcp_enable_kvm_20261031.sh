#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
WORK="$(mktemp -d)"
initial_status=""
finish() {
  rc=$?
  trap - EXIT
  if (( rc != 0 )) && [[ "$initial_status" == RUNNING ]]; then
    state="$(gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format='value(status)' 2>/dev/null || true)"
    if [[ "$state" == TERMINATED ]]; then
      echo 'RECOVERY=attempting to restart the original test VM'
      gcloud compute instances start "$VM" --project="$PROJECT" --zone="$ZONE" --quiet || true
    fi
  fi
  rm -rf -- "$WORK"
  exit "$rc"
}
trap finish EXIT

gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format=json > "$WORK/before.json"
read -r initial_status machine nested < <(python3 - "$WORK/before.json" <<'PY'
import json, sys
x=json.load(open(sys.argv[1]))
assert x.get('name') == 'kmj-cloudos-kvm-test', 'Wrong target instance'
assert x.get('zone','').endswith('/us-central1-a'), 'Wrong zone'
assert x.get('status') in ('RUNNING','TERMINATED'), 'Unexpected instance status'
assert not x.get('createdBy'), 'Managed instance: refuse machine type change'
assert not any(d.get('type')=='SCRATCH' for d in x.get('disks',[])), 'Local SSD: refuse machine change'
assert any(d.get('boot') for d in x.get('disks',[])), 'Boot disk not identified'
status=x['status']
mt=x['machineType'].split('/')[-1]
nested=x.get('advancedMachineFeatures',{}).get('enableNestedVirtualization',False)
print(status,mt,str(nested).lower())
PY
)
echo "TARGET=$VM  ZONE=$ZONE  MACHINE_BEFORE=$machine  NESTED_BEFORE=$nested"
case "$machine" in
  e2-*)
    echo 'ACTION=change E2 test instance to n2-standard-2 (billing rate may increase)'
    gcloud compute machine-types describe n2-standard-2 --project="$PROJECT" --zone="$ZONE" --format='value(name)' >/dev/null
    if [[ "$initial_status" == RUNNING ]]; then
      gcloud compute instances stop "$VM" --project="$PROJECT" --zone="$ZONE" --quiet
    fi
    gcloud compute instances set-machine-type "$VM" --project="$PROJECT" --zone="$ZONE" --machine-type=n2-standard-2 --quiet
    gcloud compute instances start "$VM" --project="$PROJECT" --zone="$ZONE" --quiet
    ;;
  n2-*) echo 'ACTION=keep existing compatible N2 machine type' ;;
  *) echo "BLOCKED=machine $machine needs separate compatibility review" >&2; exit 2 ;;
esac

if [[ "$nested" != true || "$machine" == e2-* ]]; then
  gcloud compute instances export "$VM" --project="$PROJECT" --zone="$ZONE" --destination="$WORK/current.yaml" --quiet
  python3 - "$WORK/current.yaml" <<'PY'
from pathlib import Path
import sys, re
p=Path(sys.argv[1]); lines=p.read_text().splitlines(keepends=True)
where=[i for i,s in enumerate(lines) if s.startswith('advancedMachineFeatures:')]
if not where:
    lines.extend(['\nadvancedMachineFeatures:\n','  enableNestedVirtualization: true\n'])
else:
    assert len(where)==1, 'Ambiguous advancedMachineFeatures config'
    i=where[0]
    assert lines[i].strip()=='advancedMachineFeatures:', 'Unexpected YAML format'
    j=i+1
    while j<len(lines) and (lines[j].startswith(' ') or not lines[j].strip()): j+=1
    nested_keys=[k for k in range(i+1,j) if re.match(r'^\s+enableNestedVirtualization\s*:', lines[k])]
    if nested_keys:
        assert len(nested_keys)==1
        lines[nested_keys[0]]='  enableNestedVirtualization: true\n'
    else: lines.insert(i+1,'  enableNestedVirtualization: true\n')
p.write_text(''.join(lines))
PY
  echo 'ACTION=enable nested virtualization on existing test VM'
  gcloud compute instances update-from-file "$VM" --project="$PROJECT" --zone="$ZONE" --source="$WORK/current.yaml" --most-disruptive-allowed-action=RESTART --quiet
fi

gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format='value(name,status,machineType,advancedMachineFeatures.enableNestedVirtualization)'
final_nested="$(gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format='value(advancedMachineFeatures.enableNestedVirtualization)')"
[[ "${final_nested,,}" == true ]] || { echo 'NESTED_GCE_FLAG=FAIL'; exit 1; }
echo 'NESTED_GCE_FLAG=PASS'
echo 'NEXT=verify /dev/kvm and VT-x inside the test VM before claiming VM lifecycle readiness'
