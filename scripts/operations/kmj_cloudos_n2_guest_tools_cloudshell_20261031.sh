#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
P=kmj-techno
Z=us-central1-a
V=kmj-cloudos-kvm-test
REF=eae14bd1b15ed9f99ca881db1e120da281313e7a
HELPER=kmj_cloudos_n2_guest_tools_helper_20261031.sh
HELPER_SHA=238fb60f92a4bbc86c6fb9cbdb45666dd0b689fa2632f39b97f3c5fae20f1faf
STAGE=kmj_cloudos_guest_tools_20261031
OUT="$HOME/kmj_cloudos_n2_guest_tools_stage_20261031.txt"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
exec > >(tee "$OUT") 2>&1
echo KMJ_CLOUDOS_N2_GUEST_TOOLS_STAGE_V1
echo SCOPE=EXISTING_N2_ONLY_NO_NEW_CLOUD_RESOURCES
gcloud compute instances describe "$V" --project="$P" --zone="$Z" --format=json >"$TMP/gce.json"
python3 - "$TMP/gce.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x.get('name')=='kmj-cloudos-kvm-test'
assert x.get('status')=='RUNNING'
assert x.get('zone','').endswith('/us-central1-a')
assert x.get('machineType','').endswith('/n2-standard-2')
assert x.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
print('TARGET_GUARD=PASS')
PY
curl -fLSs --retry 3 --connect-timeout 12 --max-time 90 \
 --proto '=https' --proto-redir '=https' \
 "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$REF/scripts/operations/$HELPER" -o "$TMP/$HELPER"
echo "$HELPER_SHA  $TMP/$HELPER" | sha256sum -c -
bash -n "$TMP/$HELPER"
echo HELPER_SHA256=PASS
gcloud compute scp "$TMP/$HELPER" "$V:~/$HELPER" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet
INSPECT="$(timeout --signal=TERM --kill-after=5s 90s gcloud compute ssh "$V" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$HELPER; echo '$HELPER_SHA  '\$f | sha256sum -c - && sudo -n bash \"\$f\" inspect")"
printf '%s\n' "$INSPECT"
printf '%s\n' "$INSPECT" | grep -qx APT_PLAN=PASS
N="$(printf '%s\n' "$INSPECT" | grep -c '^PACKAGE|' || true)"
test "$N" -le 16
echo "HOST_DEPENDENCIES=$N"
gcloud compute ssh "$V" --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
 --command="d=\$HOME/$STAGE; test ! -L \"\$d\" && mkdir -p -m 700 \"\$d\" && test -d \"\$d\" && chmod 700 \"\$d\""
COUNT=0
while IFS='|' read -r tag pkg ver arch sha rel; do
 if [ "$tag" != PACKAGE ] && [ "$tag" != GUEST_QGA ]; then continue; fi
 [[ "$pkg" =~ ^[A-Za-z0-9.+-]+$ ]]
 [[ "$sha" =~ ^[a-f0-9]{64}$ ]]
 [[ "$arch" = amd64 || "$arch" = all ]]
 [[ "$rel" =~ ^pool/[A-Za-z0-9_+./%-]+$ ]]
 [[ "$rel" != *..* ]]
 base="$(basename "$rel")"
 [[ "$base" =~ ^[A-Za-z0-9.+_%-]+[.]deb$ ]]
 f="$TMP/$base"
 echo "DOWNLOAD=$pkg VERSION=$ver"
 if curl -fLSs --retry 2 --connect-timeout 15 --max-time 150 \
  --proto '=https' --proto-redir '=https' \
  "https://archive.ubuntu.com/ubuntu/$rel" -o "$f"; then
  echo DOWNLOAD_SOURCE=OFFICIAL_UBUNTU_ARCHIVE
 elif curl -fLSs --retry 2 --connect-timeout 15 --max-time 150 \
  --proto '=https' --proto-redir '=https' \
  "https://security.ubuntu.com/ubuntu/$rel" -o "$f"; then
  echo DOWNLOAD_SOURCE=OFFICIAL_UBUNTU_SECURITY
 else
  echo "BLOCKED=PACKAGE_DOWNLOAD_$pkg"
  exit 5
 fi
 echo "$sha  $f" | sha256sum -c -
 test "$(dpkg-deb -f "$f" Package)" = "$pkg"
 test "$(dpkg-deb -f "$f" Version)" = "$ver"
 test "$(dpkg-deb -f "$f" Architecture)" = "$arch"
 gcloud compute scp "$f" "$V:~/$STAGE/$base" \
   --project="$P" --zone="$Z" --tunnel-through-iap --quiet
 COUNT=$((COUNT+1))
done <<< "$INSPECT"
test "$COUNT" -eq "$((N+1))"
echo "SHA256_VERIFIED_PACKAGES_STAGED=$COUNT"
timeout --signal=TERM --kill-after=5s 145s gcloud compute ssh "$V" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$HELPER; echo '$HELPER_SHA  '\$f | sha256sum -c - && sudo -n bash \"\$f\" install"
echo RESULT=OFFLINE_OVMF_CLOUD_LOCALDS_AND_QGA_STAGE_PASS
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$OUT"
