#!/usr/bin/env bash
# Orchestrate APT SHA256-verified package transfer over existing IAP SSH only.
# Never creates Cloud NAT, paid GCE resources, or public SSH exposure.
set -Eeuo pipefail
umask 077
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
REF=4b1a65b7c500c17dda92fb6cf393a9a049fd5655
HELPER_SHA=a460ab641587edfc24ea3129dabd45168682919b9ac1de15f0b6a3ccb879803f
HELPER=kmj_cloudos_n2_offline_qemu_guest_20261031.sh
DEB=qemu-utils_8.2.2+ds-0ubuntu1.18_amd64.deb
TMP="$(mktemp -d)"
OUT="$HOME/kmj_cloudos_n2_offline_qemu_repair_20261031.txt"
trap 'rm -rf -- "$TMP"' EXIT
exec > >(tee "$OUT") 2>&1
echo KMJ_CLOUDOS_N2_OFFLINE_QEMU_REPAIR_V1
echo SCOPE=EXISTING_N2_TEST_VM_NO_CLOUD_NAT
echo "TARGET=$PROJECT/$ZONE/$VM"
gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format=json > "$TMP/instance.json"
python3 - "$TMP/instance.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x.get('name')=='kmj-cloudos-kvm-test'
assert x.get('zone','').endswith('/us-central1-a')
assert x.get('status')=='RUNNING'
assert x.get('machineType','').endswith('/n2-standard-2')
assert x.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
print('GCE_IDENTITY_AND_NESTED=PASS')
PY
curl -fLSs --retry 3 --connect-timeout 12 --max-time 90 \
  --proto '=https' --proto-redir '=https' \
  "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$REF/scripts/operations/$HELPER" -o "$TMP/$HELPER"
echo "$HELPER_SHA  $TMP/$HELPER" | sha256sum -c -
bash -n "$TMP/$HELPER"
gcloud compute scp "$TMP/$HELPER" "$VM:~/$HELPER" \
  --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet
echo HELPER_TRANSFER=PASS
inspect="$(timeout --signal=TERM --kill-after=5s 85s gcloud compute ssh "$VM" \
  --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
  --command="f=\$HOME/$HELPER; echo '$HELPER_SHA  '\$f | sha256sum -c - && sudo -n bash \"\$f\" inspect")"
printf '%s\n' "$inspect"
echo "$inspect" | grep -q '^APT_METADATA=PASS$'
EXPECTED="$(printf '%s\n' "$inspect" | sed -n 's/^DEB_SHA256=//p' | tail -n 1)"
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]] || { echo APT_EXPECTED_SHA_INVALID; exit 5; }
if printf '%s\n' "$inspect" | grep -q '^QEMU_IMG=PRESENT$'; then
  echo 'PACKAGE_TRANSFER=SKIPPED_BINARY_ALREADY_PRESENT'
else
  echo 'PACKAGE_DOWNLOAD=CLOUD_SHELL_OFFICIAL_UBUNTU_HTTPS'
  curl -fLSs --retry 3 --connect-timeout 12 --max-time 180 \
    --proto '=https' --proto-redir '=https' \
    "https://archive.ubuntu.com/ubuntu/pool/main/q/qemu/qemu-utils_8.2.2%2Bds-0ubuntu1.18_amd64.deb" \
    -o "$TMP/$DEB"
  echo "$EXPECTED  $TMP/$DEB" | sha256sum -c -
  test "$(dpkg-deb -f "$TMP/$DEB" Package)" = qemu-utils
  test "$(dpkg-deb -f "$TMP/$DEB" Version)" = "1:8.2.2+ds-0ubuntu1.18"
  test "$(dpkg-deb -f "$TMP/$DEB" Architecture)" = amd64
  echo PACKAGE_DOWNLOAD_SHA=PASS
  gcloud compute scp "$TMP/$DEB" "$VM:~/$DEB" \
    --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet
  echo PACKAGE_TRANSFER=PASS
  timeout --signal=TERM --kill-after=5s 125s gcloud compute ssh "$VM" \
    --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
    --command="f=\$HOME/$HELPER; echo '$HELPER_SHA  '\$f | sha256sum -c - && sudo -n bash \"\$f\" install '/home/info_kmjtechno_com/$DEB'"
fi
echo 'NETWORK_ACTIVATION=GUARDED_TEST_VM_ONLY'
timeout --signal=TERM --kill-after=5s 95s gcloud compute ssh "$VM" \
  --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
  --command="f=\$HOME/$HELPER; echo '$HELPER_SHA  '\$f | sha256sum -c - && sudo -n bash \"\$f\" network"
echo RESULT=OFFLINE_QEMU_REPAIR_AND_DEFAULT_NETWORK_PASS
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$OUT"
