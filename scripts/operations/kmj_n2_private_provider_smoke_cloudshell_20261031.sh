#!/usr/bin/env bash
# Cloud Shell only: transfer exact private repo CloudOS provider source over IAP.
# Requires already-authorized owner GitHub read access (git helper or gh auth).
# Never prints tokens, uploads source publicly, or creates Google Cloud resources.
set -Eeuo pipefail
umask 077
P=kmj-techno
Z=us-central1-a
V=kmj-cloudos-kvm-test
HOST_SCRIPT=kmj_n2_private_provider_smoke_host_20261031.sh
HOST_REF=33d102fbdbc2cd19e4b356e6211a87fd5da50ce9
HOST_SHA=f5eef9ac16a72c29662f55cb0cd539a51da72048416511fb2bce66f16a89f5ac
ARCHIVE=kmj_n2_cloudos_provider_private_20261031.tar
BRANCH=feat/libvirt-provider-recovery-20261010
TMP="$(mktemp -d)"
OUT="$HOME/kmj_cloudos_n2_private_provider_smoke_20261031.txt"
trap 'rm -rf -- "$TMP"' EXIT
exec > >(tee "$OUT") 2>&1
echo KMJ_CLOUDOS_N2_REAL_PRIVATE_PROVIDER_SMOKE_V1
echo SCOPE=GCE_EXISTING_N2_ONLY_PRIVATE_OWNER_REPOSITORY
gcloud compute instances describe "$V" --project="$P" --zone="$Z" --format=json >"$TMP/gce.json"
python3 - "$TMP/gce.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get('name')=='kmj-cloudos-kvm-test'
assert d.get('status')=='RUNNING'
assert d.get('zone','').endswith('/us-central1-a')
assert d.get('machineType','').endswith('/n2-standard-2')
assert d.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
print('GCE_IDENTITY_AND_NESTED=PASS')
PY
curl -fLSs --retry 3 --connect-timeout 12 --max-time 80 \
 --proto '=https' --proto-redir '=https' \
 "https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/$HOST_REF/scripts/operations/$HOST_SCRIPT" \
 -o "$TMP/$HOST_SCRIPT"
echo "$HOST_SHA  $TMP/$HOST_SCRIPT" | sha256sum -c -
bash -n "$TMP/$HOST_SCRIPT"
echo HOST_RUNNER_READBACK=PASS
gcloud compute scp "$TMP/$HOST_SCRIPT" "$V:~/$HOST_SCRIPT" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet
echo HOST_RUNNER_TRANSFER=PASS
plan="$(timeout --signal=TERM --kill-after=5s 85s gcloud compute ssh "$V" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$HOST_SCRIPT; echo '$HOST_SHA  '\$f | sha256sum -c - && sudo -n bash \"\$f\" plan")"
printf '%s\n' "$plan"
if printf '%s\n' "$plan" | grep -qx 'APT_METADATA=PASS'; then
 SHA="$(printf '%s\n' "$plan" | sed -n 's/^APT_SHA256=//p' | tail -n1)"
 REL="$(printf '%s\n' "$plan" | sed -n 's/^APT_PATH=//p' | tail -n1)"
 VER="$(printf '%s\n' "$plan" | sed -n 's/^APT_VERSION=//p' | tail -n1)"
 ARCH="$(printf '%s\n' "$plan" | sed -n 's/^APT_ARCH=//p' | tail -n1)"
 [[ "$SHA" =~ ^[a-f0-9]{64}$ ]]
 [[ "$REL" =~ ^pool/[A-Za-z0-9_+./%-]+[.]deb$ ]]
 [[ "$REL" != *..* ]]
 [[ "$ARCH" = all || "$ARCH" = amd64 ]]
 echo 'RUNTIME_DEPENDENCY=OFFLINE_DEFUSEDXML'
 if curl -fLSs --retry 2 --connect-timeout 12 --max-time 150 \
  --proto '=https' --proto-redir '=https' \
  "https://archive.ubuntu.com/ubuntu/$REL" -o "$TMP/defusedxml.deb"; then
   echo PACKAGE_SOURCE=UBUNTU_ARCHIVE
 elif curl -fLSs --retry 2 --connect-timeout 12 --max-time 150 \
  --proto '=https' --proto-redir '=https' \
  "https://security.ubuntu.com/ubuntu/$REL" -o "$TMP/defusedxml.deb"; then
   echo PACKAGE_SOURCE=UBUNTU_SECURITY
 else echo BLOCKED=DEFUSEDXML_DOWNLOAD_FAILED;exit 6; fi
 echo "$SHA  $TMP/defusedxml.deb" | sha256sum -c -
 test "$(dpkg-deb -f "$TMP/defusedxml.deb" Package)" = python3-defusedxml
 test "$(dpkg-deb -f "$TMP/defusedxml.deb" Version)" = "$VER"
 test "$(dpkg-deb -f "$TMP/defusedxml.deb" Architecture)" = "$ARCH"
 gcloud compute scp "$TMP/defusedxml.deb" "$V:~/kmj_n2_python_defusedxml_20261031.deb" \
  --project="$P" --zone="$Z" --tunnel-through-iap --quiet
 timeout --signal=TERM --kill-after=5s 105s gcloud compute ssh "$V" \
  --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
  --command="f=\$HOME/$HOST_SCRIPT; echo '$HOST_SHA  '\$f | sha256sum -c - && sudo -n bash \"\$f\" install"
elif printf '%s\n' "$plan" | grep -qx 'RUNTIME_DEPS=PASS'; then
 echo RUNTIME_DEPENDENCY=ALREADY_PRESENT
else
 echo BLOCKED=RUNTIME_DEPENDENCY_UNKNOWN
 exit 5
fi
echo PRIVATE_REPO_ACCESS=CHECK_WITHOUT_PRINTING_CREDENTIALS
# Do not ask for passwords in Cloud Shell; use existing owner Git credential helper.
export GIT_TERMINAL_PROMPT=0
export GCM_INTERACTIVE=never
SRC=''
if timeout --signal=TERM --kill-after=5s 100s git clone -q --depth=1 --single-branch \
  --branch "$BRANCH" https://github.com/kmjtechno/kmj-cloudos.git \
  "$TMP/source-git" 2>/dev/null; then
 SRC="$TMP/source-git"
elif command -v gh >/dev/null 2>&1 && gh auth status -h github.com >/dev/null 2>&1 && \
 timeout --signal=TERM --kill-after=5s 100s git -c 'credential.helper=!gh auth git-credential' \
  clone -q --depth=1 --single-branch --branch "$BRANCH" \
  https://github.com/kmjtechno/kmj-cloudos.git "$TMP/source-gh" 2>/dev/null; then
 SRC="$TMP/source-gh"
else
 echo BLOCKED=PRIVATE_GITHUB_AUTH_NOT_CONFIGURED_IN_CLOUD_SHELL
 echo HINT=GITHUB_REPO_IS_PRIVATE_NO_SOURCE_EXPOSED
 echo RECEIPT_COMPLETE=YES
 exit 7
fi
echo PRIVATE_REPO_OWNER_AUTH=PASS
HEAD="$(git -C "$SRC" rev-parse HEAD)"
[[ "$HEAD" =~ ^[a-f0-9]{40}$ ]]
echo "PRIVATE_SOURCE_COMMIT=$HEAD"
while IFS='|' read -r path expected; do
 test "$(git -C "$SRC" hash-object "$path")" = "$expected" || { echo BLOCKED=EXACT_SOURCE_CHANGED; exit 8; }
done <<'BLOBS'
src/hypervisor/runtime/provider.py|1fb38a1676cb1369a17e45ec689a85317718fd53
src/hypervisor/runtime/libvirt_provider.py|971e6e6eccc8aef80824abf8b938019a199499c5
scripts/ci_libvirt_provider_smoke.py|e48d474358dc1c489b0c9d19861877634d74b42d
scripts/ci_libvirt_lifecycle_checks.py|f7cce02f079228b8b64fafcaa3533a859102edda
BLOBS
echo EXACT_PRIVATE_SOURCE_GIT_BLOBS=PASS
git -C "$SRC" archive --format=tar \
 --output="$TMP/$ARCHIVE" "$HEAD" \
 src/hypervisor/runtime/provider.py \
 src/hypervisor/runtime/libvirt_provider.py \
 scripts/ci_libvirt_provider_smoke.py \
 scripts/ci_libvirt_lifecycle_checks.py
chmod 0600 "$TMP/$ARCHIVE"
ARCHIVE_SHA="$(sha256sum "$TMP/$ARCHIVE" | awk '{print $1}')"
[[ "$ARCHIVE_SHA" =~ ^[a-f0-9]{64}$ ]]
echo "PRIVATE_ARCHIVE_SHA256=$ARCHIVE_SHA"
gcloud compute scp "$TMP/$ARCHIVE" "$V:~/$ARCHIVE" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet
echo PRIVATE_ARCHIVE_IAP_TRANSFER=PASS
echo ACTION=RUN_PRIVATE_CLOUDOS_PROVIDER
timeout --signal=TERM --kill-after=45s 760s gcloud compute ssh "$V" \
 --project="$P" --zone="$Z" --tunnel-through-iap --quiet \
 --command="f=\$HOME/$HOST_SCRIPT; echo '$HOST_SHA  '\$f | sha256sum -c - && sudo -n timeout --signal=TERM --kill-after=35s 690s bash \"\$f\" run '$ARCHIVE_SHA'"
echo RESULT=REAL_PRIVATE_CLOUDOS_PROVIDER_TEST_PASS
echo RECEIPT_COMPLETE=YES
echo "RECEIPT_PATH=$OUT"
