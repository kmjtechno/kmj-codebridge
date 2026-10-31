#!/usr/bin/env bash
# Cloud Shell orchestration for one disposable offline Noble/QGA KVM boot.
# Exact-hash GitHub scripts, APT-metadata-verified guest liburing2 package.
# No new GCE resources, public SSH/firewall, or existing guest/domain changes.
set -Eeuo pipefail
umask 077
P=kmj-techno
Z=us-central1-a
V=kmj-cloudos-kvm-test
PLAN=kmj_cloudos_n2_liburing_plan_20261031.py
PLAN_REF=8a18b1d1736208276e5928a11355d400900d8383
PLAN_SHA=39f504506c1a0996612ef842f6aa3a3994deae303c6e8e5cd448db3f8521c1a4
SMOKE=kmj_cloudos_n2_offline_qga_prepare_20261031.py
SMOKE_REF=bb8d3b00bb95144f29d104d633fdfd8f0d93c17d
SMOKE_SHA=8c5338bc4c71d4a4643e749aae54e2d11000a121c283d6bdedf4eba3e71e8551
STAGE=kmj_cloudos_guest_tools_20261031
OUT="$HOME/kmj_cloudos_n2_offline_qga_boot_20261031.txt"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
exec > >(tee "$OUT") 2>&1
echo KMJ_CLOUDOS_N2_OFFLINE_QGA_BOOT_ORCHESTRATOR_V1
echo SCOPE=EXISTING_N2_TEST_NODE_GUEST_ONLY
echo TARGET=kmj-techno/us-central1-a/kmj-cloudos-kvm-test
gcloud compute instances describe "$V" --project="$P" --zone="$Z" --format=json >"$TMP/gce.json"
python3 - "$TMP/gce.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x.get('name')=='kmj-cloudos-kvm-test'
assert x.get('status')=='RUNNING'
assert x.get('zone','').endswith('/us-central1-a')
assert x.get('machineType','').endswith('/n2-standard-2')
assert x.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
print('GCE_TARGET_GUARD=PASS')
PY
for item in "$PLAN" "$SMOKE"; do
 if [ "$item" = "$PLAN" ]; then ref="$PLAN_REF"; sha="$PLAN_SHA"; else ref="$SMOKE_REF"; sha="$SMOKE_SHA"; fi
 curl -fLSs --retry 3 --connect-timeout 12 --max-time 90 \
  --proto '=https' --proto-redir '=https' \
  "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$ref/scripts/operations/$item" -o "$TMP/$item"
 echo "$sha  $TMP/$item" | sha256sum -c -
 python3 -m py_compile "$TMP/$item"
 gcloud compute scp "$TMP/$item" "$V:~/$item" \
  --project="$P" --zone="$Z" --tunnel-through-iap --quiet
done
echo PYTHON_HELPERS_VERIFIED_AND_TRANSFERRED=PASS
PLANNED="$(timeout --signal=TERM --kill-after=8s 90s gcloud compute ssh "$V" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$PLAN; echo '$PLAN_SHA  '\$f | sha256sum -c - && sudo -n python3 \"\$f\"")"
printf '%s\n' "$PLANNED"
printf '%s\n' "$PLANNED" | grep -qx RESULT=LIBURING_PLAN_PASS
VERSION="$(printf '%s\n' "$PLANNED" | sed -n 's/^LIBURING_VERSION=//p' | tail -n1)"
EXPECTED="$(printf '%s\n' "$PLANNED" | sed -n 's/^LIBURING_SHA256=//p' | tail -n1)"
REL="$(printf '%s\n' "$PLANNED" | sed -n 's/^LIBURING_APT_PATH=//p' | tail -n1)"
[[ "$VERSION" =~ ^[A-Za-z0-9.+:~-]+$ ]]
[[ "$EXPECTED" =~ ^[a-f0-9]{64}$ ]]
[[ "$REL" =~ ^pool/[A-Za-z0-9_+./%-]+[.]deb$ ]]
[[ "$REL" != *..* ]]
DEB="$(basename "$REL")"
[[ "$DEB" =~ ^liburing2_[A-Za-z0-9.+~%-]+_amd64[.]deb$ ]]
echo "LIBURING_APT_VERSION=$VERSION"
if curl -fLSs --retry 3 --connect-timeout 15 --max-time 180 \
 --proto '=https' --proto-redir '=https' \
 "https://archive.ubuntu.com/ubuntu/$REL" -o "$TMP/$DEB"; then
 echo DOWNLOAD_SOURCE=OFFICIAL_UBUNTU_ARCHIVE
elif curl -fLSs --retry 3 --connect-timeout 15 --max-time 180 \
 --proto '=https' --proto-redir '=https' \
 "https://security.ubuntu.com/ubuntu/$REL" -o "$TMP/$DEB"; then
 echo DOWNLOAD_SOURCE=OFFICIAL_UBUNTU_SECURITY
else echo BLOCKED=OFFICIAL_LIBURING2_DOWNLOAD; exit 5; fi
echo "$EXPECTED  $TMP/$DEB" | sha256sum -c -
test "$(dpkg-deb -f "$TMP/$DEB" Package)" = liburing2
test "$(dpkg-deb -f "$TMP/$DEB" Version)" = "$VERSION"
test "$(dpkg-deb -f "$TMP/$DEB" Architecture)" = amd64
echo VERIFIED_GUEST_LIBURING2=PASS
gcloud compute scp "$TMP/$DEB" "$V:~/$STAGE/$DEB" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet
echo GUEST_LIBURING2_TRANSFER=PASS
echo ACTION=ONE_DISPOSABLE_KVM_UEFI_QGA_GUEST_BOOT
timeout --signal=TERM --kill-after=50s 1100s gcloud compute ssh "$V" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$SMOKE; echo '$SMOKE_SHA  '\$f | sha256sum -c - && sudo -n timeout --signal=TERM --kill-after=45s 900s python3 -u \"\$f\" --uring-deb '/home/info_kmjtechno_com/$STAGE/$DEB' --uring-sha256 '$EXPECTED' --max-wait 540"
echo RESULT=N2_DISPOSABLE_QGA_PREP_VERIFIED_PASS
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$OUT"
