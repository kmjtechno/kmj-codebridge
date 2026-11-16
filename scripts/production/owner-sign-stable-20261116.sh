#!/usr/bin/env bash
# OWNER-ONLY. Builds the exact source archive for one reviewed main commit and
# signs the release manifest with YOUR Ed25519 key, using the repository's own
# signer (scripts/sign-runtime-manifest.js). The private key is only read by
# that signer. This script uploads, publishes and deploys NOTHING, and never
# prints key material.
#
# Required env:
#   CB_REPO                     clean checkout detached at SOURCE, with node_modules
#   SOURCE                      full 40-hex commit to sign (the reviewed main commit)
#   CODEBRIDGE_RELEASE_KEY_FILE private key file OUTSIDE CB_REPO, no group/other access
#   CODEBRIDGE_RELEASE_KID      key id, for example kmj-release-2026
#   SEQ                         integer >= 29 (28 is the live release)
#   CONFIRM_SIGN                SIGN_STABLE_SEQ_<SEQ>_<first 12 hex of SOURCE>
# Optional: OUT (default $HOME/kmj-release-seq<SEQ>)
set -Eeuo pipefail
umask 077
fail() { printf 'KMJ_OWNER_SIGN=BLOCKED:%s\n' "$1"; exit 2; }
: "${CB_REPO:?}" "${SOURCE:?}" "${CODEBRIDGE_RELEASE_KEY_FILE:?}" "${CODEBRIDGE_RELEASE_KID:?}" "${SEQ:?}" "${CONFIRM_SIGN:?}"
[[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]] || fail SOURCE_NOT_FULL_SHA
[[ "$SEQ" =~ ^[0-9]+$ ]] && (( SEQ >= 29 )) || fail SEQUENCE_MUST_BE_AT_LEAST_29
[[ "$CONFIRM_SIGN" == "SIGN_STABLE_SEQ_${SEQ}_${SOURCE:0:12}" ]] || fail CONFIRMATION_MISMATCH
[[ "$CODEBRIDGE_RELEASE_KID" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || fail KID_INVALID
[[ -f "$CODEBRIDGE_RELEASE_KEY_FILE" && ! -L "$CODEBRIDGE_RELEASE_KEY_FILE" ]] || fail KEY_FILE_MISSING
case "$(uname)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) [[ -z "$(find "$CODEBRIDGE_RELEASE_KEY_FILE" -maxdepth 0 -perm /077)" ]] || fail KEY_FILE_TOO_OPEN ;;
esac
cd "$CB_REPO"
[[ "$(git rev-parse HEAD)" == "$SOURCE" ]] || fail REPO_HEAD_NOT_SOURCE
[[ -z "$(git status --porcelain)" ]] || fail REPO_NOT_CLEAN
[[ -d node_modules/zod ]] || fail RUN_npm_ci_omit_dev_ignore_scripts_FIRST
# A commit that already has signed metadata must never be signed again.
[[ ! -e "releases/stable/$SOURCE" ]] || fail SOURCE_ALREADY_RELEASED
OUT="${OUT:-$HOME/kmj-release-seq$SEQ}"
[[ ! -e "$OUT" ]] || fail OUTPUT_DIR_EXISTS
version=$(git show "$SOURCE:package.json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail VERSION_INVALID
stem="kmj-codebridge-$version-${SOURCE:0:12}"; archive="$stem.tar.gz"
mkdir -p "$OUT/work" "$OUT/release"
git archive --format=tar.gz --prefix="$stem/" --output="$OUT/release/$archive" "$SOURCE"
sha=$(sha256sum "$OUT/release/$archive" | cut -d' ' -f1); bytes=$(stat -c %s "$OUT/release/$archive")
node -e '
const [v,r,a,b,s]=process.argv.slice(1);
process.stdout.write(JSON.stringify({product:"KMJ CodeBridge",format:"source-runtime",signed:false,version:v,revision:r,archive:a,bytes:Number(b),sha256:s}));
' "$version" "$SOURCE" "$archive" "$bytes" "$sha" > "$OUT/work/runtime-manifest.json"
URL="https://kmjtechno.com/codebridge/releases/stable/$SOURCE/$archive"
export CODEBRIDGE_RELEASE_KEY_FILE CODEBRIDGE_RELEASE_KID
node scripts/sign-runtime-manifest.js "$OUT/work/runtime-manifest.json" "$URL" "$SEQ" "$OUT/release/signed"
[[ -s "$OUT/release/signed/release-manifest.json" && -s "$OUT/release/signed/release-manifest.sig" ]] || fail SIGNER_OUTPUT_MISSING
# Public files only, in one folder, for the review PR. No key material is here.
mkdir -p "$OUT/public"
cp "$OUT/release/signed/release-manifest.json" "$OUT/release/signed/release-manifest.sig" "$OUT/public/"
printf 'KMJ_OWNER_SIGN=SIGNED\nSEQUENCE=%s\nSOURCE=%s\nARCHIVE=%s\nARCHIVE_SHA256=%s\nARCHIVE_BYTES=%s\nMANIFEST_SHA256=%s\nSIG_SHA256=%s\nPUBLIC_DIR=%s\nARCHIVE_DIR=%s\nPUBLISHED=NO\nDEPLOYED=NO\n' \
  "$SEQ" "$SOURCE" "$archive" "$sha" "$bytes" \
  "$(sha256sum "$OUT/public/release-manifest.json" | cut -d' ' -f1)" \
  "$(sha256sum "$OUT/public/release-manifest.sig" | cut -d' ' -f1)" \
  "$OUT/public" "$OUT/release"
