#!/usr/bin/env bash
# Fixed trusted CodeBridge CI entry. No arbitrary repo, command, ref or SHA.
set -Eeuo pipefail
umask 077
[[ "$EUID" -eq 0 && $# -eq 0 ]] || { echo KMJ_CI_FIXED_ENTRY_DENIED >&2; exit 2; }
repo=/srv/kmj-codebridge-projects/kmj-main-platform
expected=refs/remotes/origin/fix/public-marketing-standalone-nav-20261008
[[ -d "$repo/.git" && ! -L "$repo/.git" ]] || { echo KMJ_CI_FIXED_PROJECT_UNAVAILABLE >&2; exit 3; }
# Git can fail with status 128 (inaccessible ref, ownership, inaccessible
# worktree). Convert it to a bounded status instead of leaking raw stderr.
if ! sha="$(/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -c safe.directory="$repo" -C "$repo" rev-parse --verify "$expected" 2>/dev/null)"; then
  echo KMJ_CI_FIXED_REF_LOOKUP_FAILED >&2
  exit 3
fi
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo KMJ_CI_FIXED_REVISION_INVALID >&2; exit 3; }
[[ "$sha" == 7a6d163dab3a7676d8dacc58fb0624bca3255c00 ]] || { echo KMJ_CI_FIXED_SHA_MISMATCH >&2; exit 3; }
# No checkout mutations or fetch; exact pinned ref is checked in privileged preparer.
exec /bin/bash /opt/kmj-codebridge-agent/scripts/ci-main-platform-pr337.sh "$sha"
