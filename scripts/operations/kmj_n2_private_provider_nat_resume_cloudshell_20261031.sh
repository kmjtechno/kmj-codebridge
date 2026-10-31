#!/usr/bin/env bash
# Cloud Shell: exact SHA verified guarded N2 NAT recovery and resume.
# Private CloudOS source archive was already transferred in the prior authenticated run.
set -Eeuo pipefail
umask 077
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
REF=28b89521cfd49367e2fa102780f0c80fed8df5ce
HELPER=kmj_n2_private_provider_nat_resume_host_20261031.sh
HELPER_SHA=168e91fcf92fbac4a5286df493a7830fb9d532a3e0aced342633ab2cf41f11ec
OUT="$HOME/kmj_n2_private_provider_nat_resume_20261031.txt"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
exec > >(tee "$OUT") 2>&1
echo KMJ_N2_PROVIDER_NET_RESUME_CLOUDSHELL_V1
echo SCOPE=EXISTING_N2_LIBVIRT_NAT_AND_PRIVATE_SOURCE_ONLY
gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format=json >"$TMP/gce.json"
python3 - "$TMP/gce.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x.get('name')=='kmj-cloudos-kvm-test'
assert x.get('status')=='RUNNING'
assert x.get('zone','').endswith('/us-central1-a')
assert x.get('machineType','').endswith('/n2-standard-2')
assert x.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
print('GCE_TARGET_N2_GUARD=PASS')
PY
curl -fLSs --retry 3 --connect-timeout 12 --max-time 85 \
 --proto '=https' --proto-redir '=https' \
 "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$REF/scripts/operations/$HELPER" \
 -o "$TMP/$HELPER"
echo "$HELPER_SHA  $TMP/$HELPER" | sha256sum -c -
bash -n "$TMP/$HELPER"
echo VERIFIED_HOST_RESUME_SCRIPT=PASS
gcloud compute scp "$TMP/$HELPER" "$VM:~/$HELPER" \
 --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet
echo HOST_RESUME_SCRIPT_TRANSFER=PASS
echo ACTION=GUARDED_EXISTING_NAT_RECOVERY_AND_PRIVATE_PROVIDER_TEST
timeout --signal=TERM --kill-after=45s 835s gcloud compute ssh "$VM" \
 --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$HELPER; echo '$HELPER_SHA  '\$f | sha256sum -c - && sudo -n timeout --signal=TERM --kill-after=40s 755s bash \"\$f\""
echo RESULT=GUARDED_N2_PRIVATE_PROVIDER_RESUME_PASS
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$OUT"
