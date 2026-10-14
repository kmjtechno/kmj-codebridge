#!/usr/bin/env bash
# One-command owner bootstrap for fixed, exact-SHA PR419 private Linux QA.
# No production deploy, live payment, checkout reset, or entitlement changes.
set -Eeuo pipefail
umask 077
[[ "$EUID" -eq 0 && "$#" -eq 0 ]] || { echo PAYMENT_QA_ROOT_NO_ARGS_REQUIRED >&2; exit 2; }
source_sha="7ddd1ebee16f262fd34ec0625c43fff5bd4083d5"
review_sha="82458ef28186acb32a16103bbeba7b1e30595273"
branch="feat/payment-gateway-guided-onboarding-20261014"
runtime="/opt/kmj-codebridge-agent"
project="/srv/kmj-codebridge-projects/kmj-main-platform"
unit="kmj-codebridge-private-pr419-ci.service"
for tool in curl tar git systemctl python3 timeout runuser cmp install; do
  command -v "$tool" >/dev/null || { echo "PAYMENT_QA_MISSING_TOOL=$tool" >&2; exit 2; }
done
[[ -d "$runtime/scripts" && ! -L "$runtime" && ! -L "$runtime/scripts" && -f "$runtime/src/license.js" ]] || { echo PAYMENT_QA_RUNTIME_MISSING >&2; exit 3; }
[[ -d "$project/.git" && ! -L "$project/.git" ]] || { echo PAYMENT_QA_PROJECT_MISSING >&2; exit 3; }
getent passwd kmjcode >/dev/null || { echo PAYMENT_QA_PROJECT_OWNER_MISSING >&2; exit 3; }
tmp="$(mktemp -d)"
trap 'rm -rf --one-file-system -- "$tmp"' EXIT
curl --fail --location --silent --show-error --retry 3 --connect-timeout 10 --max-time 90   "https://codeload.github.com/kmjtechno/kmj-codebridge/tar.gz/$source_sha" -o "$tmp/source.tgz"
mkdir "$tmp/source"
tar -xzf "$tmp/source.tgz" -C "$tmp/source" --strip-components=1
for file in ci-main-platform-pr-worker.sh ci-main-platform-pr419.sh ci-main-platform-pr419-fixed.sh install-private-pr419-ci-unit.sh; do
  [[ -f "$tmp/source/scripts/$file" && ! -L "$tmp/source/scripts/$file" ]] || { echo PAYMENT_QA_SOURCE_INVALID >&2; exit 3; }
done
grep -Fq '"pr": 419,' "$tmp/source/scripts/ci-main-platform-pr419.sh" || { echo PAYMENT_QA_EVIDENCE_CONTRACT_MISMATCH >&2; exit 3; }
grep -Fq "$review_sha" "$tmp/source/scripts/ci-main-platform-pr419-fixed.sh" || { echo PAYMENT_QA_PIN_MISMATCH >&2; exit 3; }
grep -Fq "$review_sha" "$tmp/source/scripts/ci-main-platform-pr419.sh" || { echo PAYMENT_QA_PIN_MISMATCH >&2; exit 3; }
if [[ -f "$runtime/scripts/ci-main-platform-pr-worker.sh" ]]; then
  [[ ! -L "$runtime/scripts/ci-main-platform-pr-worker.sh" ]] || { echo PAYMENT_QA_WORKER_SYMLINK >&2; exit 3; }
  cmp -s "$runtime/scripts/ci-main-platform-pr-worker.sh" "$tmp/source/scripts/ci-main-platform-pr-worker.sh" || { echo PAYMENT_QA_WORKER_VERSION_CONFLICT >&2; exit 3; }
fi
[[ -z "$(runuser -u kmjcode -- git -C "$project" status --porcelain --untracked-files=no)" ]] || { echo PAYMENT_QA_TRACKED_CHECKOUT_DIRTY >&2; exit 3; }
# Fetch only one known review ref, never switch HEAD or touch unrelated files.
timeout 90 runuser -u kmjcode -- env GIT_TERMINAL_PROMPT=0 git -C "$project" fetch --no-tags origin   "refs/heads/$branch:refs/remotes/origin/$branch"
actual="$(runuser -u kmjcode -- git -C "$project" rev-parse --verify "refs/remotes/origin/$branch")"
[[ "$actual" == "$review_sha" ]] || { echo PAYMENT_QA_REVIEW_REF_MISMATCH >&2; exit 3; }
for file in ci-main-platform-pr-worker.sh ci-main-platform-pr419.sh ci-main-platform-pr419-fixed.sh install-private-pr419-ci-unit.sh; do
  dst="$runtime/scripts/$file"
  [[ ! -L "$dst" && ( ! -e "$dst" || -f "$dst" ) ]] || { echo PAYMENT_QA_DEST_UNSAFE >&2; exit 3; }
  install -o root -g root -m 0755 "$tmp/source/scripts/$file" "$dst"
done
bash "$runtime/scripts/install-private-pr419-ci-unit.sh"
systemctl start "$unit"
python3 - "$review_sha" <<'PY'
import json, pathlib, sys
record = json.loads(pathlib.Path("/var/lib/kmj-codebridge-ci/evidence/latest-pr419.json").read_text())
print("PAYMENT_PR419_SHA=" + str(record.get("sha", "UNKNOWN")))
print("PAYMENT_PR419_LINUX_RESULT=" + str(record.get("linux_result", "UNKNOWN")))
print("PAYMENT_PR419_FAILED_GATE=" + str(record.get("failed_gate", "NONE")))
print("PAYMENT_PR419_FAILURE_KIND=" + str(record.get("failure_kind", "NONE")))
if record.get("pr") != 419 or record.get("sha") != sys.argv[1] or record.get("linux_result") != "PASS" or record.get("exit_code") != 0:
    raise SystemExit(1)
print("PAYMENT_PR419_ISOLATED_LINUX_QA_PASS=1")
PY
