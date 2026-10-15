#!/usr/bin/env bash
# One-command gateway upgrade for the KMJ-elite VPS. Run as root:
#   sudo bash FIX-GATEWAY-ONE-CLICK.sh <40-hex-sha>
# Stages the pinned commit, runs the guarded cutover dry-run, then asks once
# before --apply. The cutover rolls back automatically on failure.
set -euo pipefail
SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <full 40-hex sha>" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 2; }
CAND=/opt/kmj-codebridge-candidates
USERNAME=kmjcode
DEST="$CAND/$SHA"
CUT=""
if [[ ! -d "$DEST" ]]; then
  install -d -m 0755 "$CAND"
  git clone --quiet https://github.com/kmjtechno/kmj-codebridge "$DEST"
  git -C "$DEST" checkout --quiet --detach "$SHA"
  [[ "$(git -C "$DEST" rev-parse HEAD)" == "$SHA" ]] || { echo "SHA mismatch"; exit 1; }
  (cd "$DEST" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  chown -R "$USERNAME":"$USERNAME" "$DEST"
fi
CUT="$DEST/scripts/gateway-cutover.mjs"
echo "== DRY RUN =="
node "$CUT" --target-sha "$SHA"
read -r -p "Dry-run OK and no jobs running? Type APPLY to continue: " ans
[[ "$ans" == "APPLY" ]] || { echo "aborted, nothing changed"; exit 0; }
node "$CUT" --target-sha "$SHA" --apply --confirm-no-active-jobs
