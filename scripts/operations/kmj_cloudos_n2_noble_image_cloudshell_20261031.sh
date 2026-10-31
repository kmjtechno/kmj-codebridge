#!/usr/bin/env bash
# Cloud Shell: official Noble QCOW2 verification + IAP transfer to one existing N2 VM.
# Only local files / test VM filesystem, no new GCE resources or guest starts.
set -Eeuo pipefail
umask 077
P=kmj-techno
Z=us-central1-a
V=kmj-cloudos-kvm-test
B=noble-server-cloudimg-amd64.img
PIN=04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94
REF=06509a9135690879710a86f27c2707925b677655
H=kmj_cloudos_n2_noble_image_stage_20261031.sh
H_SHA=bbc34db19e323894263b0e9e7262dfccaa625c574c8b82fbb72bbdc946066144
OUT="$HOME/kmj_cloudos_n2_noble_image_stage_20261031.txt"
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
exec > >(tee "$OUT") 2>&1
echo KMJ_CLOUDOS_N2_OFFICIAL_NOBLE_IMAGE_TRANSFER_V1
echo SCOPE=OFFICIAL_CHECKSUM_PINNED_BASE_ONLY
echo "TARGET=$P/$Z/$V"
gcloud compute instances describe "$V" --project="$P" --zone="$Z" --format=json >"$TEMP/gce.json"
python3 - "$TEMP/gce.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
assert x.get('name')=='kmj-cloudos-kvm-test'
assert x.get('zone','').endswith('/us-central1-a')
assert x.get('status')=='RUNNING'
assert x.get('machineType','').endswith('/n2-standard-2')
assert x.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
print('TARGET_N2_IDENTITY=PASS')
PY
curl -fLSs --retry 3 --connect-timeout 15 --max-time 90 \
 --proto '=https' --proto-redir '=https' \
 "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$REF/scripts/operations/$H" -o "$TEMP/$H"
echo "$H_SHA  $TEMP/$H" | sha256sum -c -
bash -n "$TEMP/$H"
echo HELPER_READBACK_SHA256=PASS
curl -fLSs --retry 3 --connect-timeout 15 --max-time 90 \
 --proto '=https' --proto-redir '=https' \
 https://cloud-images.ubuntu.com/noble/current/SHA256SUMS -o "$TEMP/SHA256SUMS"
grep -E '(^|[ *])noble-server-cloudimg-amd64[.]img$' "$TEMP/SHA256SUMS" >"$TEMP/target.sha"
test "$(wc -l <"$TEMP/target.sha")" -eq 1
OFFICIAL="$(awk '{print $1}' "$TEMP/target.sha")"
test "$OFFICIAL" = "$PIN" || { echo BLOCKED=OFFICIAL_IMAGE_RELEASE_CHANGED; exit 4; }
echo OFFICIAL_SHA256_PIN=PASS
DEST="$HOME/$B"
if [ -L "$DEST" ]; then echo BLOCKED=LOCAL_IMAGE_SYMLINK; exit 4; fi
if [ -e "$DEST" ] && [ ! -f "$DEST" ]; then echo BLOCKED=LOCAL_IMAGE_PATH_UNSAFE; exit 4; fi
if [ -f "$DEST" ] && (echo "$PIN  $DEST" | sha256sum -c - >/dev/null 2>&1); then
 echo DOWNLOAD=ALREADY_VERIFIED
else
 echo DOWNLOAD=OFFICIAL_UBUNTU_NOBLE_QCOW2
 curl -fLSs --retry 4 --retry-delay 3 --connect-timeout 20 --max-time 2400 \
  -C - --proto '=https' --proto-redir '=https' \
  https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img -o "$DEST"
fi
echo "$PIN  $DEST" | sha256sum -c -
echo LOCAL_IMAGE_SHA256=PASS
size="$(stat -c %s "$DEST")"
test "$size" -ge 250000000 && test "$size" -le 1500000000
echo "IMAGE_BYTES=$size"
gcloud compute scp "$TEMP/$H" "$V:~/$H" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet
echo HELPER_TRANSFER=PASS
STATUS="$(timeout --signal=TERM --kill-after=5s 80s gcloud compute ssh "$V" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$B; if test -L \"\$f\"; then echo REMOTE_IMAGE_UNSAFE_SYMLINK; elif test -f \"\$f\" && echo '$PIN  '\$f | sha256sum -c - >/dev/null 2>&1; then echo REMOTE_IMAGE_ALREADY_VERIFIED; elif test -e \"\$f\"; then echo REMOTE_IMAGE_UNVERIFIED_EXISTING; else echo REMOTE_IMAGE_NEEDS_TRANSFER; fi")"
echo "$STATUS"
case "$STATUS" in
 *REMOTE_IMAGE_ALREADY_VERIFIED*) echo IMAGE_TRANSFER=SKIPPED_VERIFIED;;
 *REMOTE_IMAGE_NEEDS_TRANSFER*)
   echo IMAGE_TRANSFER=IAP_SCP
   timeout --signal=TERM --kill-after=5s 2400s gcloud compute scp "$DEST" "$V:~/$B" \
    --project="$P" --zone="$Z" --tunnel-through-iap --quiet
   echo IMAGE_TRANSFER=PASS;;
 *) echo BLOCKED=REMOTE_IMAGE_STATUS;exit 5;;
esac
timeout --signal=TERM --kill-after=5s 220s gcloud compute ssh "$V" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$H; echo '$H_SHA  '\$f | sha256sum -c - && sudo -n timeout --signal=TERM --kill-after=5s 160s bash \"\$f\""
echo RESULT=OFFICIAL_NOBLE_IMAGE_VERIFIED_AND_STAGED_PASS
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$OUT"
