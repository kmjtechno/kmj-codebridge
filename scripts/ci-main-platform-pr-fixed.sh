#!/usr/bin/env bash
# Fixed trusted CodeBridge CI entry. No arbitrary repo, command, ref or SHA.
set -Eeuo pipefail
umask 077
[[ "$EUID" -eq 0 && $# -eq 0 ]] || { echo KMJ_CI_FIXED_ENTRY_DENIED >&2; exit 2; }
repo=/srv/kmj-codebridge-projects/kmj-main-platform
expected=refs/remotes/origin/feat/codebridge-owner-tier
[[ -d "$repo/.git" && ! -L "$repo/.git" ]] || { echo KMJ_CI_FIXED_PROJECT_UNAVAILABLE >&2; exit 3; }
sha="$(git -c safe.directory="$repo" -C "$repo" rev-parse --verify "$expected" 2>/dev/null)"
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo KMJ_CI_FIXED_REVISION_INVALID >&2; exit 3; }
# No checkout mutations or fetch; exact pinned ref is checked in privileged preparer.
exec /bin/bash /opt/kmj-codebridge-agent/scripts/ci-main-platform-pr.sh "$sha"
