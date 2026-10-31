#!/usr/bin/env bash
# Cloud Shell: download and SHA-verify exact Ubuntu APT dependencies before IAP transfer.
set -Eeuo pipefail
umask 077
PROJECT=kmj-techno
ZONE=us-central1-a
VM=kmj-cloudos-kvm-test
REF=58f61b7dc3fb8a1fee08fb182b77e7f0eab7c429
HELPER=kmj_cloudos_n2_dnsmasq_helper_20261031.sh
H_SHA=74760dc7bb95034d742a662ba9d086c348b5e04ef12b6fc6d2e7074ae0bb3083
STAGE=kmj_n2_dnsmasq_20261031
TMP="$(mktemp -d)"
OUT="$HOME/kmj_cloudos_n2_dnsmasq_repair_20261031.txt"
trap 'rm -rf -- "$TMP"' EXIT
exec > >(tee "$OUT") 2>&1
echo KMJ_CLOUDOS_N2_DNSMASQ_REPAIR_V1
echo "TARGET=$PROJECT/$ZONE/$VM"
echo SCOPE=ONLY_EXISTING_N2_NO_CLOUD_NAT_NO_PUBLIC_FIREWALL
gcloud compute instances describe "$VM" --project="$PROJECT" --zone="$ZONE" --format=json >"$TMP/gce.json"
python3 - "$TMP/gce.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x.get('name')=='kmj-cloudos-kvm-test'
assert x.get('zone','').endswith('/us-central1-a')
assert x.get('status')=='RUNNING'
assert x.get('machineType','').endswith('/n2-standard-2')
assert x.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
print('TARGET_IDENTITY=PASS')
PY
curl -fLSs --retry 3 --connect-timeout 12 --max-time 90 \
  --proto '=https' --proto-redir '=https' \
  "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$REF/scripts/operations/$HELPER" \
  -o "$TMP/$HELPER"
echo "$H_SHA  $TMP/$HELPER" | sha256sum -c -
bash -n "$TMP/$HELPER"
echo HELPER_SHA256=PASS
gcloud compute scp "$TMP/$HELPER" "$VM:~/$HELPER" \
  --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet
echo HELPER_UPLOAD=PASS
INSPECT="$(timeout --signal=TERM --kill-after=5s 90s gcloud compute ssh "$VM" \
  --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
  --command="f=\$HOME/$HELPER; echo '$H_SHA  '\$f | sha256sum -c - && sudo -n bash \"\$f\" inspect")"
printf '%s\n' "$INSPECT"
printf '%s\n' "$INSPECT" | grep -qx 'APT_SIMULATION=PASS'
COUNT="$(printf '%s\n' "$INSPECT" | sed -n 's/^PLANNED_COUNT=//p' | tail -n1)"
test -n "$COUNT"
[[ "$COUNT" =~ ^[0-9]+$ ]]
test "$COUNT" -le 12
echo "PACKAGE_COUNT=$COUNT"
if [ "$COUNT" -gt 0 ]; then
  gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" \
    --tunnel-through-iap --quiet \
    --command="d=\$HOME/$STAGE; test ! -L \"\$d\" && mkdir -p -m 700 \"\$d\" && test -d \"\$d\" && chmod 700 \"\$d\""
  echo PACKAGE_STAGING=READY
  n=0
  while IFS='|' read -r marker pkg version sha rel; do
    if [ "$marker" != PACKAGE ]; then continue; fi
    [[ "$pkg" =~ ^[a-z0-9][a-z0-9.+-]*$ ]]
    [[ "$sha" =~ ^[a-f0-9]{64}$ ]]
    [[ "$rel" =~ ^pool/[a-zA-Z0-9._+/%-]+$ ]]
    [[ "$rel" != *..* ]]
    base="$(basename "$rel")"
    [[ "$base" =~ ^[A-Za-z0-9._+%-]+\.deb$ ]]
    echo "PACKAGE=$pkg VERSION=$version"
    f="$TMP/$base"
    if curl -fLSs --retry 2 --connect-timeout 12 --max-time 120 \
      --proto '=https' --proto-redir '=https' \
      "https://archive.ubuntu.com/ubuntu/$rel" -o "$f"; then
      echo DOWNLOAD_SOURCE=OFFICIAL_UBUNTU_ARCHIVE
    elif curl -fLSs --retry 2 --connect-timeout 12 --max-time 120 \
      --proto '=https' --proto-redir '=https' \
      "https://security.ubuntu.com/ubuntu/$rel" -o "$f"; then
      echo DOWNLOAD_SOURCE=OFFICIAL_UBUNTU_SECURITY
    else
      echo "BLOCKED=PACKAGE_DOWNLOAD_FAILED_$pkg"
      exit 6
    fi
    echo "$sha  $f" | sha256sum -c -
    test "$(dpkg-deb -f "$f" Package)" = "$pkg"
    test "$(dpkg-deb -f "$f" Version)" = "$version"
    test "$(dpkg-deb -f "$f" Architecture)" = amd64
    gcloud compute scp "$f" "$VM:~/$STAGE/$base" \
      --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet
    n=$((n+1))
  done <<< "$INSPECT"
  test "$n" -eq "$COUNT"
  echo ALL_PACKAGE_SHA256=PASS
  echo "PACKAGES_UPLOADED=$n"
  timeout --signal=TERM --kill-after=5s 140s gcloud compute ssh "$VM" \
    --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
    --command="f=\$HOME/$HELPER; echo '$H_SHA  '\$f | sha256sum -c - && sudo -n bash \"\$f\" install"
else
  echo PACKAGES_ALREADY_INSTALLED=YES
fi
echo NETWORK_ACTIVATION=GUARDED_ONLY
timeout --signal=TERM --kill-after=5s 95s gcloud compute ssh "$VM" \
  --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
  --command="f=\$HOME/$HELPER; echo '$H_SHA  '\$f | sha256sum -c - && sudo -n bash \"\$f\" network"
echo RESULT=N2_OFFLINE_DNSMASQ_AND_NAT_PASS
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$OUT"
