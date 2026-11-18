#!/usr/bin/env bash
# KMJ CodeBridge — ONE-COMMAND stable release (owner only).
#
#   npm run release            # sign latest main, open the review PR
#   npm run release -- --yes   # same, without the single confirmation prompt
#
# What it does, in order:
#   1. fetches origin/main and picks its newest commit (or SOURCE=<sha>)
#   2. checks that every CI check on that exact commit passed (needs gh)
#   3. picks the next sequence number automatically (highest existing + 1)
#   4. asks ONE confirmation, then signs with your offline Ed25519 key via
#      scripts/production/owner-sign-stable-20261116.sh (key never leaves
#      your machine, nothing is uploaded by the signer)
#   5. commits only the two public files to branch release/stable-seq<N>,
#      pushes it and opens the PR
# After you merge that PR, .github/workflows/publish-signed-stable.yml
# verifies it again and creates the GitHub release automatically.
# This script never deploys, promotes or restarts anything.
#
# One-time setup — a file with two lines (default path below):
#   ~/.config/kmj-codebridge/release.env
#     CODEBRIDGE_RELEASE_KEY_FILE=/path/outside/repo/release-ed25519.pem
#     CODEBRIDGE_RELEASE_KID=kmj-release-2026
# Environment variables with the same names take priority over the file.
set -Eeuo pipefail
umask 077
say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nKMJ_RELEASE=BLOCKED:%s\n' "$1" >&2; [[ -n "${2:-}" ]] && printf '%s\n' "$2" >&2; exit 2; }

YES=no
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=yes ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) fail UNKNOWN_ARGUMENT "Only --yes is supported." ;;
  esac
done

# --- settings (env first, then the private config file; never sourced) -----
CONF="${KMJ_RELEASE_CONFIG:-$HOME/.config/kmj-codebridge/release.env}"
conf_get() {
  [[ -f "$CONF" ]] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CONF" | tail -n1 | sed 's/^"\(.*\)"$/\1/; s/[[:space:]]*$//'
}
KEY_FILE="${CODEBRIDGE_RELEASE_KEY_FILE:-$(conf_get CODEBRIDGE_RELEASE_KEY_FILE)}"
KID="${CODEBRIDGE_RELEASE_KID:-$(conf_get CODEBRIDGE_RELEASE_KID)}"
KID="${KID:-kmj-release-2026}"
KEY_FILE="${KEY_FILE/#\~/$HOME}"
[[ -n "$KEY_FILE" ]] || fail KEY_FILE_NOT_CONFIGURED \
  "Create $CONF with a line: CODEBRIDGE_RELEASE_KEY_FILE=/path/to/your/private-key.pem"
[[ -f "$KEY_FILE" ]] || fail KEY_FILE_MISSING "Not found: $KEY_FILE"

command -v git >/dev/null || fail GIT_MISSING
command -v node >/dev/null || fail NODE_MISSING
command -v npm >/dev/null || fail NPM_MISSING
# A missing or unauthenticated GitHub CLI must NEVER bypass CI.
command -v gh >/dev/null || fail GH_CLI_REQUIRED
gh auth status >/dev/null 2>&1 || fail GH_AUTH_REQUIRED

REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO"
REMOTE_URL="$(git remote get-url origin)"
case "$REMOTE_URL" in
  https://github.com/kmjtechno/kmj-codebridge|https://github.com/kmjtechno/kmj-codebridge.git|git@github.com:kmjtechno/kmj-codebridge.git) ;;
  *) fail CODEBRIDGE_REMOTE_NOT_TRUSTED ;;
esac
[[ -z "${KMJ_RELEASE_REPO:-}" || "$KMJ_RELEASE_REPO" == kmjtechno/kmj-codebridge ]] ||
  fail REPO_OVERRIDE_UNTRUSTED
SLUG=kmjtechno/kmj-codebridge

# --- 1. source commit --------------------------------------------------------
say "Fetching latest main"
git fetch -q origin main
SOURCE="${SOURCE:-$(git rev-parse origin/main)}"
[[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]] || fail SOURCE_NOT_FULL_SHA
git merge-base --is-ancestor "$SOURCE" origin/main || fail SOURCE_NOT_ON_MAIN
git cat-file -e "origin/main:releases/stable/$SOURCE/release-manifest.json" 2>/dev/null \
  && fail SOURCE_ALREADY_RELEASED "This commit already has a signed release."

# --- 2. exact-commit CI ------------------------------------------------------
say "Verifying five exact-head GitHub Actions checks on ${SOURCE:0:12}"
if ! CI_RECEIPT="$(gh api "repos/$SLUG/commits/$SOURCE/check-runs?per_page=100" |
  node scripts/release-ci-gate.mjs "$SOURCE")"; then
  fail CI_NOT_INDEPENDENTLY_VERIFIED \
    "Five required exact-SHA GitHub Actions jobs must be completed successfully."
fi
printf '%s\n' "$CI_RECEIPT"

# --- 3. next sequence --------------------------------------------------------
# Enumerate actual tracked manifests recursively, never just the tree root.
MANIFEST_PATHS="$(git ls-tree -r --name-only origin/main -- releases/stable/ |
  grep -E '^releases/stable/[a-f0-9]{40}/release-manifest\.json$' || true)"
[[ -n "$MANIFEST_PATHS" ]] || fail SIGNED_HISTORY_NOT_FOUND
SEQ="$(while IFS= read -r manifest; do
  git show "origin/main:$manifest" | node -e '
    let text=""; process.stdin.on("data",chunk=>text+=chunk);
    process.stdin.on("end",()=>{const m=JSON.parse(text);
    if(m.schema!==1||m.product!=="KMJ CodeBridge"||
    m.channel!=="stable"||m.keyId!=="kmj-release-2026"||
    !Number.isSafeInteger(m.sequence)||m.sequence<1)process.exit(2);
    console.log(m.sequence);});
  ' || exit 2
done <<< "$MANIFEST_PATHS" | node -e '
  let s=""; process.stdin.on("data",b=>s+=b);
  process.stdin.on("end",()=>{const seqs=s.trim().split(/\s+/).map(Number);
  if(!seqs.length||seqs.some(n=>!Number.isSafeInteger(n)||n<1)||
  new Set(seqs).size!==seqs.length)process.exit(2);
  console.log(Math.max(...seqs)+1);});
')"
[[ "$SEQ" =~ ^[0-9]+$ ]] && (( SEQ >= 30 )) || fail SEQUENCE_UNKNOWN
VERSION="$(git show "$SOURCE:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
BRANCH="release/stable-seq$SEQ"
git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 \
  && fail BRANCH_EXISTS "origin/$BRANCH already exists. Merge or delete it first."

cat <<EOF

  Release to sign
  ---------------
  Sequence : $SEQ
  Version  : $VERSION
  Commit   : $SOURCE
  Subject  : $(git log -1 --format=%s "$SOURCE")
  Key id   : $KID

EOF
if [[ "$YES" != yes ]]; then
  read -r -p "Sign and open the release PR? [y/N] " answer
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || fail CANCELLED_BY_OWNER
fi

# --- 4. sign in a clean temporary checkout ----------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kmj-release-XXXXXX")"
CREATED_RELEASE_BRANCH=no
cleanup() {
  git -C "$REPO" worktree remove --force "$WORK/src" >/dev/null 2>&1 || true
  git -C "$REPO" worktree remove --force "$WORK/pr" >/dev/null 2>&1 || true
  # Only remove a disposable branch actually created by THIS process.
  if [[ "$CREATED_RELEASE_BRANCH" == yes ]]; then
    git -C "$REPO" branch -q -D "$BRANCH" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
say "Preparing clean checkout"
git worktree add -q --detach "$WORK/src" "$SOURCE"
(cd "$WORK/src" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null)

OUT="${OUT:-$HOME/kmj-release-seq$SEQ}"
say "Signing sequence $SEQ"
CB_REPO="$WORK/src" SOURCE="$SOURCE" SEQ="$SEQ" OUT="$OUT" \
  CODEBRIDGE_RELEASE_KEY_FILE="$KEY_FILE" CODEBRIDGE_RELEASE_KID="$KID" \
  CONFIRM_SIGN="SIGN_STABLE_SEQ_${SEQ}_${SOURCE:0:12}" \
  bash "$WORK/src/scripts/production/owner-sign-stable-20261116.sh" | tee "$WORK/sign.txt"
grep -qx 'KMJ_OWNER_SIGN=SIGNED' "$WORK/sign.txt" || fail SIGNING_FAILED
MANIFEST_SHA="$(sed -n 's/^MANIFEST_SHA256=//p' "$WORK/sign.txt")"
ARCHIVE_SHA="$(sed -n 's/^ARCHIVE_SHA256=//p' "$WORK/sign.txt")"

# --- 5. review PR with the two public files ---------------------------------
say "Creating branch $BRANCH"
git worktree add -q -b "$BRANCH" "$WORK/pr" origin/main
CREATED_RELEASE_BRANCH=yes
mkdir -p "$WORK/pr/releases/stable/$SOURCE"
cp "$OUT/public/release-manifest.json" "$OUT/public/release-manifest.sig" "$WORK/pr/releases/stable/$SOURCE/"
# Same check CI runs, locally, before anything is pushed.
(cd "$WORK/pr" && node scripts/verify-stable-release.mjs "$SOURCE" >/dev/null) \
  || fail LOCAL_VERIFY_FAILED "Run: node scripts/verify-stable-release.mjs $SOURCE"
git -C "$WORK/pr" add "releases/stable/$SOURCE"
git -C "$WORK/pr" commit -q -m "release: owner-signed stable sequence $SEQ (${SOURCE:0:12})" \
  -m "Manifest SHA256: $MANIFEST_SHA" -m "Archive SHA256: $ARCHIVE_SHA"
git -C "$WORK/pr" push -q -u origin "$BRANCH"

BODY="Owner-signed stable sequence **$SEQ** for \`$SOURCE\` (v$VERSION).

| | SHA-256 |
|---|---|
| release-manifest.json | \`$MANIFEST_SHA\` |
| archive | \`$ARCHIVE_SHA\` |

The **Publish owner-signed CodeBridge stable release** check rebuilds the archive from Git and must PASS. Merging creates the GitHub release automatically. Origin publication, latest-feed roll and gateway promotion stay owner-run."
URL="$(gh api "repos/$SLUG/pulls" -f base=main -f head="$BRANCH" \
  -f title="release: owner-signed stable sequence $SEQ" -f body="$BODY" --jq .html_url </dev/null)"

cat <<EOF

KMJ_RELEASE=PR_READY
SEQUENCE=$SEQ
SOURCE=$SOURCE
MANIFEST_SHA256=$MANIFEST_SHA
PR=$URL
NEXT=When the PR check is green, merge it. The GitHub release is created automatically.
EOF
