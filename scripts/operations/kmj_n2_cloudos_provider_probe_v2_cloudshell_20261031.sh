#!/usr/bin/env bash
# One-host, SHA-pinned CloudOS provider resume after libvirt net-info false-negative.
# Private CloudOS archive is already staged by the previously authenticated owner run.
set -Eeuo pipefail
umask 077
P=kmj-techno
Z=us-central1-a
V=kmj-cloudos-kvm-test
REF=141e784e031c4d005b8d23b55a81441aac3bddac
HELPER=kmj_n2_private_provider_smoke_host_v2_20261031.sh
EXPECTED_HELPER_SHA=74780cc2295489d059eae8608b3ec8bbc92a0b5f5847ab7c865593e73f9adc67
ARCHIVE_SHA=9e5330cba2162e78f40763406ccfb08214dca76d34e017cc18d931a35f8fd7f5
T="$(mktemp -d)"
trap 'rm -rf -- "$T"' EXIT
OUT="$HOME/kmj_n2_cloudos_provider_probe_v2_20261031.txt"
exec > >(tee "$OUT") 2>&1
echo KMJ_CLOUDOS_PRIVATE_PROVIDER_NET_PARSE_FIX_V2
echo SCOPE=EXISTING_N2_ONLY_NO_CLOUD_MUTATIONS_NO_NEW_AUTH
gcloud compute instances describe "$V" --project="$P" --zone="$Z" --format=json >"$T/target.json"
python3 - "$T/target.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get('name')=='kmj-cloudos-kvm-test'
assert d.get('status')=='RUNNING'
assert d.get('zone','').endswith('/us-central1-a')
assert d.get('machineType','').endswith('/n2-standard-2')
assert d.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
print('TARGET_IDENTITY_NESTED=PASS')
PY
curl -fLSs --retry 3 --connect-timeout 12 --max-time 90 \
 --proto '=https' --proto-redir '=https' \
 "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$REF/scripts/operations/$HELPER" -o "$T/$HELPER"
echo "$EXPECTED_HELPER_SHA  $T/$HELPER" | sha256sum -c -
bash -n "$T/$HELPER"
echo HELPER_SHA_AND_SYNTAX=PASS
gcloud compute scp "$T/$HELPER" "$V:~/$HELPER" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet
echo IAP_HELPER_TRANSFER=PASS
echo ACTION=RUN_EXISTING_VERIFIED_PRIVATE_CLOUDOS_PROVIDER
timeout --signal=TERM --kill-after=45s 850s gcloud compute ssh "$V" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$HELPER; echo '$EXPECTED_HELPER_SHA  '\$f | sha256sum -c - && sudo -n timeout --signal=TERM --kill-after=40s 760s bash \"\$f\" run '$ARCHIVE_SHA'"
echo RESULT=REAL_PRIVATE_CLOUDOS_PROVIDER_TEST_PASS
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$OUT"
