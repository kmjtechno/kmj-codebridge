#!/usr/bin/env bash
# Existing N2 only. Clone-safe Ubuntu image preparation and extended private CloudOS provider retry.
# Both pinned source scripts public (without private CloudOS source). Private files remain N2-only.
set -Eeuo pipefail
umask 077
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
IMAGE_SCRIPT=kmj_n2_cloudos_qga_clone_safe_image_20261031.py
IMAGE_REF=533abc881d20980ef946e76e26ac90b43b17ca1d
IMAGE_SHA=4c76ce99ffae7fe64e1c60c985325df004adfce58f2d6ace983f53145065b611
SMOKE_SCRIPT=kmj_n2_cloudos_provider_extended_clonesafe_20261031.sh
SMOKE_REF=bb68fb742d93de63c176b2d72807c17c698e7720
SMOKE_SHA=8bdd76a0ce35a7e0f60bacce1b24c87fb5aba34460e935ef72071ab7092234a7
OUT="$HOME/kmj_n2_cloudos_clonesafe_extended_20261031.txt"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
exec > >(tee "$OUT") 2>&1
echo KMJ_CLOUDOS_N2_CLONE_SAFE_EXTENDED_CLOUDSHELL_V1
echo SCOPE=EXISTING_N2_NO_NEW_GCE_RESOURCE_NO_CUSTOMER_DOMAIN
gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format=json >"$TMP/gce.json"
python3 - "$TMP/gce.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get('name')=='kmj-cloudos-kvm-test'
assert d.get('status')=='RUNNING'
assert d.get('machineType','').endswith('/n2-standard-2')
assert d.get('zone','').endswith('/us-central1-a')
assert d.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
print('EXACT_N2_IDENTITY_NESTED_KVM=PASS')
PY
curl -fLSs --retry 3 --connect-timeout 12 --max-time 90 --proto '=https' --proto-redir '=https' \
 "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$IMAGE_REF/scripts/operations/$IMAGE_SCRIPT" -o "$TMP/$IMAGE_SCRIPT"
echo "$IMAGE_SHA  $TMP/$IMAGE_SCRIPT" | sha256sum -c -
python3 -m py_compile "$TMP/$IMAGE_SCRIPT"
curl -fLSs --retry 3 --connect-timeout 12 --max-time 90 --proto '=https' --proto-redir '=https' \
 "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$SMOKE_REF/scripts/operations/$SMOKE_SCRIPT" -o "$TMP/$SMOKE_SCRIPT"
echo "$SMOKE_SHA  $TMP/$SMOKE_SCRIPT" | sha256sum -c -
bash -n "$TMP/$SMOKE_SCRIPT"
echo SOURCE_PINS_AND_SYNTAX=PASS
gcloud compute scp "$TMP/$IMAGE_SCRIPT" "$TMP/$SMOKE_SCRIPT" "$VM:~/" \
 --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet
echo VERIFIED_SCRIPTS_IAP_TRANSFER=PASS
echo ACTION=PREPARE_NEW_CLONE_SAFE_QGA_TEMPLATE
timeout --signal=TERM --kill-after=60s 930s gcloud compute ssh "$VM" \
 --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$IMAGE_SCRIPT; echo '$IMAGE_SHA  '\$f | sha256sum -c - && sudo -n timeout --signal=TERM --kill-after=45s 825s python3 -I \"\$f\""
echo NEW_CLONE_SAFE_TEMPLATE=PASS
echo ACTION=RUN_FOUR_EXTENDED_REAL_CLOUDOS_PROVIDER_TESTS
timeout --signal=TERM --kill-after=65s 1240s gcloud compute ssh "$VM" \
 --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$SMOKE_SCRIPT; echo '$SMOKE_SHA  '\$f | sha256sum -c - && sudo -n timeout --signal=TERM --kill-after=55s 1140s bash \"\$f\""
echo RESULT=CLONE_SAFE_REAL_CLOUDOS_EXTENDED_PROVIDER_SMOKE_PASS
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$OUT"
