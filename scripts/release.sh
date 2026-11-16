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
HAVE_GH=no
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then HAVE_GH=yes; fi

REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO"
REMOTE_URL="$(git remote get-url origin)"
SLUG="${KMJ_RELEASE_REPO:-$(printf '%s' "$REMOTE_URL" | sed -nE 's#^.*github\.com[:/]([^/]+/[^/]+)$#\1#p' | sed 's/\.git$//')}"
SLUG="${SLUG:-kmjtechno/kmj-codebridge}"
[[ "$SLUG" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || fail REPO_NAME_INVALID

# --- 1. source commit --------------------------------------------------------
say "Fetching latest main"
git fetch -q origin main
SOURCE="${SOURCE:-$(git rev-parse origin/main)}"
[[ "$SOURCE" =~ ^[0-9a-f]{40}$ ]] || fail SOURCE_NOT_FULL_SHA
git merge-base --is-ancestor "$SOURCE" origin/main || fail SOURCE_NOT_ON_MAIN
git cat-file -e "origin/main:releases/stable/$SOURCE/release-manifest.json" 2>/dev/null \
  && fail SOURCE_ALREADY_RELEASED "This commit already has a signed release."

# --- 2. exact-commit CI ------------------------------------------------------
if [[ "$HAVE_GH" == yes ]]; then
  say "Checking CI on ${SOURCE:0:12}"
  ci="$(gh api "repos/$SLUG/commits/$SOURCE/check-runs?per_page=100" \
    --jq '[.check_runs[] | select(.name != "signed_release")] as $r
          | "\($r|length) \([$r[]|select(.status!="completed")]|length) \([$r[]|select(.status=="completed" and (.conclusion|IN("success","skipped","neutral")|not))]|length)"')"
  read -r total pending failed <<<"$ci"
  [[ "$total" -gt 0 ]] || fail CI_NOT_FOUND "No CI checks found for ${SOURCE:0:12} yet."
  [[ "$pending" == 0 ]] || fail CI_STILL_RUNNING "$pending check(s) still running. Try again in a few minutes."
  [[ "$failed" == 0 ]] || fail CI_FAILED "$failed check(s) failed on ${SOURCE:0:12}. Fix main first."
  echo "CI: $total checks passed"
else
  echo "gh CLI not logged in: CI check and automatic PR are skipped (you will get a link instead)."
fi

# --- 3. next sequence --------------------------------------------------------
SEQ="$(git ls-tree --name-only origin/main releases/stable/ | while read -r d; do
  git show "origin/main:$d/release-manifest.json" 2>/dev/null || true; echo; done \
  | node -e 'let s=require("fs").readFileSync(0,"utf8"),m=0;for(const x of s.match(/"sequence"\s*:\s*\d+/g)||[])m=Math.max(m,+x.split(":")[1]);console.log(m+1)')"
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
cleanup() {
  git -C "$REPO" worktree remove --force "$WORK/src" >/dev/null 2>&1 || true
  git -C "$REPO" worktree remove --force "$WORK/pr" >/dev/null 2>&1 || true
  [[ -n "${BRANCH:-}" ]] && git -C "$REPO" branch -q -D "$BRANCH" >/dev/null 2>&1 || true
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
if [[ "$HAVE_GH" == yes ]]; then
  URL="$(gh api "repos/$SLUG/pulls" -f base=main -f head="$BRANCH" \
    -f title="release: owner-signed stable sequence $SEQ" -f body="$BODY" --jq .html_url </dev/null)"
else
  URL="https://github.com/$SLUG/compare/main...$BRANCH?expand=1"
fi

cat <<EOF

KMJ_RELEASE=PR_READY
SEQUENCE=$SEQ
SOURCE=$SOURCE
MANIFEST_SHA256=$MANIFEST_SHA
PR=$URL
NEXT=When the PR check is green, merge it. The GitHub release is created automatically.
EOF
