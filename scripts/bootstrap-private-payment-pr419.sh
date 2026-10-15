#!/usr/bin/env bash
# One-command owner bootstrap for fixed, exact-SHA PR419 private Linux QA.
# No production deploy, live payment, checkout reset, or entitlement changes.
set -Eeuo pipefail
umask 077
[[ "$EUID" -eq 0 && "$#" -eq 0 ]] || { echo PAYMENT_QA_ROOT_NO_ARGS_REQUIRED >&2; exit 2; }
source_sha="7a0733a1c18f7a694034a9b01d7008ee54a0843d"
review_sha="0cc50ab391bea81c3694d3c7a51744304f8d5c91"
branch="feat/payment-gateway-guided-onboarding-20261014"
runtime="/opt/kmj-codebridge-agent"
project="/srv/kmj-codebridge-projects/kmj-main-platform"
unit="kmj-codebridge-private-pr419-ci.service"
for tool in curl tar git systemctl python3 timeout runuser cmp install stat mv; do
  command -v "$tool" >/dev/null || { echo "PAYMENT_QA_MISSING_TOOL=$tool" >&2; exit 2; }
done
[[ -d "$project/.git" && ! -L "$project/.git" ]] || { echo PAYMENT_QA_PROJECT_MISSING >&2; exit 3; }
getent passwd kmjcode >/dev/null || { echo PAYMENT_QA_PROJECT_OWNER_MISSING >&2; exit 3; }
tmp="$(mktemp -d)"
staged_runtime=""
cleanup() {
  if [[ -n "$staged_runtime" && "$staged_runtime" == /opt/.kmj-payment-ci-* ]]; then
    rm -rf --one-file-system -- "$staged_runtime"
  fi
  rm -rf --one-file-system -- "$tmp"
}
trap cleanup EXIT
curl --fail --location --silent --show-error --retry 3 --connect-timeout 10 --max-time 90   "https://codeload.github.com/kmjtechno/kmj-codebridge/tar.gz/$source_sha" -o "$tmp/source.tgz"
mkdir "$tmp/source"
tar -xzf "$tmp/source.tgz" -C "$tmp/source" --strip-components=1
for file in ci-main-platform-pr-worker.sh ci-main-platform-pr419.sh ci-main-platform-pr419-fixed.sh install-private-pr419-ci-unit.sh; do
  [[ -f "$tmp/source/scripts/$file" && ! -L "$tmp/source/scripts/$file" ]] || { echo PAYMENT_QA_SOURCE_INVALID >&2; exit 3; }
done
grep -Fq '"pr": 419,' "$tmp/source/scripts/ci-main-platform-pr419.sh" || { echo PAYMENT_QA_EVIDENCE_CONTRACT_MISMATCH >&2; exit 3; }
grep -Fq "$review_sha" "$tmp/source/scripts/ci-main-platform-pr419-fixed.sh" || { echo PAYMENT_QA_PIN_MISMATCH >&2; exit 3; }
grep -Fq "$review_sha" "$tmp/source/scripts/ci-main-platform-pr419.sh" || { echo PAYMENT_QA_PIN_MISMATCH >&2; exit 3; }
# A fresh KMJ-elite has the main-platform agent but may not have the separate
# native CodeBridge CI runtime. Bootstrap only a *missing* root-owned path,
# from the exact reviewed Git commit; never replace an existing installation.
if [[ ! -e "$runtime" && ! -L "$runtime" ]]; then
  [[ -d /opt && ! -L /opt && "$(stat -c %u /opt)" == 0 ]] || { echo PAYMENT_QA_OPT_UNTRUSTED >&2; exit 3; }
  staged_runtime="$(mktemp -d /opt/.kmj-payment-ci-XXXXXXXX)"
  git_stage() {
    /usr/bin/env -i PATH=/usr/bin:/bin HOME="$tmp" LANG=C.UTF-8 \
      GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
      GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$staged_runtime" "$@"
  }
  git_stage init --quiet --template=
  git_stage -c core.hooksPath=/dev/null fetch --quiet --depth 1 \
    https://github.com/kmjtechno/kmj-codebridge.git "$source_sha"
  git_stage -c core.hooksPath=/dev/null checkout --quiet --detach FETCH_HEAD
  [[ "$(git_stage rev-parse HEAD)" == "$source_sha" ]] || { echo PAYMENT_QA_SOURCE_SHA_MISMATCH >&2; exit 3; }
  for file in src/license.js src/errors.js package.json \
    scripts/ci-main-platform-pr-worker.sh scripts/ci-main-platform-pr419.sh \
    scripts/ci-main-platform-pr419-fixed.sh scripts/install-private-pr419-ci-unit.sh; do
    [[ -f "$staged_runtime/$file" && ! -L "$staged_runtime/$file" ]] || { echo PAYMENT_QA_SOURCE_GIT_MISSING >&2; exit 3; }
  done
  # The downloaded archive must match the exact Git object that was verified.
  for file in ci-main-platform-pr-worker.sh ci-main-platform-pr419.sh ci-main-platform-pr419-fixed.sh install-private-pr419-ci-unit.sh; do
    cmp -s "$staged_runtime/scripts/$file" "$tmp/source/scripts/$file" || { echo PAYMENT_QA_SOURCE_ARCHIVE_MISMATCH >&2; exit 3; }
  done
  [[ ! -e "$runtime" && ! -L "$runtime" ]] || { echo PAYMENT_QA_RUNTIME_CONFLICT >&2; exit 3; }
  chmod 0755 "$staged_runtime"
  mv -T -- "$staged_runtime" "$runtime"
  staged_runtime=""
  echo PAYMENT_QA_RUNTIME_BOOTSTRAPPED_FROM_VERIFIED_COMMIT
fi
[[ -d "$runtime/.git" && -d "$runtime/scripts" && -d "$runtime/src" && ! -L "$runtime" && ! -L "$runtime/scripts" && -f "$runtime/src/license.js" ]] || { echo PAYMENT_QA_RUNTIME_PARTIAL_OR_UNTRUSTED >&2; exit 3; }
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
set +e
systemctl start "$unit"
unit_rc=$?
set -e
# Always print bounded non-secret gate evidence on service failure. Do not
# dump unrestricted Laravel provider logs or any deployment credentials.
if [[ "$unit_rc" -ne 0 ]]; then
  echo PAYMENT_PR419_UNIT_EXIT="$unit_rc"
fi
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
