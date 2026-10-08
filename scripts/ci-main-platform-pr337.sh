#!/usr/bin/env bash
# Exact-head private PR #337 CI on existing VPS. No GitHub Actions runner.
# Privileged setup only; PR code executes ONLY as confined 'kmjci'.
set -Eeuo pipefail
umask 077
if [[ $# != 1 || ! "$1" =~ ^[a-f0-9]{40}$ ]]; then echo CI_INVALID_SHA >&2; exit 2; fi
sha="$1"
if [[ "$EUID" != 0 ]]; then echo CI_PREP_REQUIRES_ROOT >&2; exit 2; fi
repo=/srv/kmj-codebridge-projects/kmj-main-platform
# Offline preparation must not inherit GIT_DIR, GIT_WORK_TREE, namespaces
# or credential/config overrides from its service environment.
git_read() {
  /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
    GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 GIT_OPTIONAL_LOCKS=0 \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 \
    /usr/bin/git -c safe.directory="$repo" -C "$repo" "$@"
}
control=/opt/kmj-codebridge-agent
base=/var/lib/kmj-codebridge-ci
worker="$(dirname "$(realpath "$0")")/ci-main-platform-pr-worker.sh"
for tool in git tar python3 systemd-run flock; do command -v "$tool" >/dev/null || exit 2; done
id -u kmjci >/dev/null || { echo CI_UNPRIVILEGED_IDENTITY_MISSING >&2; exit 2; }
test -f "$worker" && test -f "$control/src/license.js" || exit 2
test -d "$repo/.git" || exit 2
[[ "$(git_read rev-parse refs/remotes/origin/fix/public-marketing-standalone-nav-20261008)" == "$sha" ]] ||
  { echo CI_REF_SHA_MISMATCH >&2; exit 3; }
[[ "$(git_read cat-file -t "$sha")" == commit ]] || exit 3
[[ -z "$(git_read status --porcelain)" ]] || { echo CI_DIRTY_SOURCE >&2; exit 3; }
echo KMJ_CI_PREP_STAGE=REF_VERIFIED
for file in apps/platform/composer.lock apps/platform/package-lock.json; do
  echo KMJ_CI_PREP_STAGE=TARGET_LOCK_READ
  target="$(git_read show "$sha:$file" | sha256sum | cut -d' ' -f1)"
  echo KMJ_CI_PREP_STAGE=HEAD_LOCK_READ
  installed="$(git_read show "HEAD:$file" | sha256sum | cut -d' ' -f1)"
  [[ "$target" == "$installed" ]] || { echo CI_DEPENDENCY_LOCK_CONFLICT >&2; exit 3; }
done
echo KMJ_CI_PREP_STAGE=LOCKS_VERIFIED
# Disallow tracked Git symlinks before root-owned archive extraction.
# Consume the whole tree: grep -q can close early, causing Git SIGPIPE and
# making this conditional false under pipefail even when a link was found.
tree_listing="$(git_read ls-tree -r "$sha")" || { echo CI_TREE_READ_FAILED >&2; exit 3; }
if awk '$1 == "120000" { found=1 } END { exit !found }' <<< "$tree_listing"; then
  echo CI_UNSAFE_TRACKED_SYMLINK >&2; exit 3
fi
install -d -o root -g root -m 0711 "$base" "$base/jobs"
install -d -o root -g root -m 0700 "$base/evidence"
exec 9>"$base/.ci.lock"
flock -n 9 || { echo CI_ALREADY_RUNNING >&2; exit 4; }
job="$(mktemp -d "$base/jobs/website337-XXXXXXXX")"
cleanup() { [[ "$job" == "$base"/jobs/website337-* ]] && rm -rf --one-file-system -- "$job"; }
trap cleanup EXIT
mkdir -p "$job/src/.codebridge-contract/src"
git_read archive --format=tar "$sha" |
  tar -x --no-same-owner --no-same-permissions -C "$job/src"
# Detached .git HEAD is a nonproduction fixture for the staging header test.
# A new credential-free Git repository contains only object history reachable
# from the reviewed head and baseline, needed by the existing triple-dot diff.
base_sha="$(git_read rev-parse --verify HEAD)"
[[ "$base_sha" =~ ^[a-f0-9]{40}$ ]] || { echo CI_BASE_SHA_INVALID >&2; exit 3; }
printf '%s\n' "$sha" "$base_sha" | git_read pack-objects --revs --stdout > "$job/history.pack"
/usr/bin/env -i PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null /usr/bin/git init -q --template= "$job/src"
/usr/bin/env -i PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null /usr/bin/git -C "$job/src" index-pack --stdin < "$job/history.pack" >/dev/null
rm -- "$job/history.pack"
printf '%s\n' "$sha" > "$job/src/.git/HEAD"
/usr/bin/env -i PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null /usr/bin/git -C "$job/src" read-tree "$sha"
printf '%s\n' "$base_sha" > "$job/src/.ci-base-sha"
# Staging needs content, modes and links, not foreign ownership or timestamps.
cp -a --no-preserve=ownership,timestamps "$repo/apps/platform/vendor" "$job/src/apps/platform/vendor"
cp -a --no-preserve=ownership,timestamps "$repo/apps/platform/node_modules" "$job/src/apps/platform/node_modules"
for package in "$job/src"/packages/domain-*; do
  [[ -d "$package/src" ]] || continue
  name="$(basename "$package")"
  target="$job/src/apps/platform/vendor/kmjtechno/$name"
  [[ ! -d "$target/src" ]] || cp -a --no-preserve=ownership,timestamps "$package/src/." "$target/src/"
done
# Copy the exact immutable consumer objects, not mutable installed files.
control_git() {
  /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -c safe.directory="$control" -C "$control" "$@"
}
consumer_sha="$(control_git rev-parse --verify HEAD)"
[[ "$consumer_sha" =~ ^[a-f0-9]{40}$ ]] || { echo CI_CONSUMER_SHA_INVALID >&2; exit 3; }
for file in src/license.js src/errors.js package.json; do
  control_git show "$consumer_sha:$file" > "$job/src/.codebridge-contract/$file"
done
consumer_license_sha256="$(sha256sum "$job/src/.codebridge-contract/src/license.js" | cut -d' ' -f1)"
cp "$worker" "$job/worker.sh"
chown -R kmjci:kmjci "$job"
log="$base/evidence/$sha-$(date -u +%Y%m%dT%H%M%SZ).log"
manifest="$(dirname "$log")/$(basename "$log" .log).json"
set +e
systemd-run --quiet --wait --collect --pipe \
  -p User=kmjci -p Group=kmjci \
  -p NoNewPrivileges=yes -p PrivateNetwork=yes -p PrivateTmp=yes \
  -p PrivateDevices=yes -p ProtectHome=yes -p ProtectSystem=strict \
  -p RestrictSUIDSGID=yes -p RestrictRealtime=yes -p LockPersonality=yes \
  -p ProtectKernelTunables=yes -p ProtectKernelModules=yes \
  -p ProtectControlGroups=yes -p CapabilityBoundingSet= \
  -p 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
  -p IPAddressDeny=any -p IPAddressAllow=localhost \
  -p "InaccessiblePaths=/srv /etc/kmj-codebridge-main-platform /var/lib/kmj-codebridge-kmj-main-platform" \
  -p "ReadWritePaths=$job" \
  -p MemoryMax=12G -p TasksMax=512 -p CPUQuota=200% -p RuntimeMaxSec=15min \
  /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$job" \
    /bin/bash "$job/worker.sh" "$job/src" >"$log" 2>&1
code=$?
set -e
chmod 0600 "$log"
# Trusted parent writes append-only SHA-bound result (never from PR code).
python3 - "$sha" "$log" "$code" "$manifest" "$base_sha" "$consumer_sha" "$consumer_license_sha256" <<'PY'
import hashlib, json, pathlib, re, sys, time
sha, log, code, output, base_sha, consumer_sha, consumer_license_sha256 = sys.argv[1:]
b = pathlib.Path(log).read_bytes()
lines = b.decode("utf-8", errors="replace").splitlines()
gates = {
    "php_key_generate", "php_migrations", "php_syntax", "platform_runtime", "license_runtime", "fmt_lint", "frontend_build", "typescript", "php_format", "php_tests",
    "activation_proof", "renewal", "node_lease_interop", "postgres_concurrency",
    "php_config_clear", "php_static_analysis", "foundation_python_runtime", "foundation_compile", "foundation_workers", "foundation_browser_qa", "foundation_policy", "foundation_backup", "foundation_architecture", "foundation_delivery", "foundation_public_surface", "foundation_free_router", "foundation_contracts", "rust_format", "rust_tests", "kslp_contract", "foundation_module_architecture", "foundation_runtime", "lease_encoder_syntax",
}
runtime_versions = {}
for line in lines:
    match = re.fullmatch(r"KMJ_CI_RUNTIME_(PHP|NODE_PLATFORM|NODE_CONSUMER|PYTHON|CARGO|POSTGRES)=(UNAVAILABLE|[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[A-Za-z0-9.-]+)?)", line)
    if match and len(match[2]) <= 64:
        runtime_versions[match[1]] = match[2]
passed = []
failed_gate = None
for line in lines:
    if line.startswith("KMJ_CI_GATE_BEGIN="):
        label = line.split("=", 1)[1]
        if label in gates:
            failed_gate = label
    elif line.startswith("KMJ_CI_GATE_PASS="):
        label = line.split("=", 1)[1]
        if label in gates:
            if label not in passed:
                passed.append(label)
            if label == failed_gate:
                failed_gate = None
failure_kind = None
if int(code) != 0:
    failure_kind = "COMMAND_FAILED_UNCLASSIFIED"
    if "KMJ_CI_PG_REQUIRED_UNAVAILABLE" in lines:
        failure_kind = "PG_UNAVAILABLE"
        failed_gate = "postgres_concurrency"
    elif any(re.search(r"(?:^|: )vp: (?:not found|command not found)$", line) for line in lines):
        failure_kind = "VP_NOT_FOUND"
    elif any(re.match(r"(?:Failed to (?:start transient service unit|connect to bus):|Failed at step |Failed to set up mount namespacing:)", line) for line in lines):
        failure_kind = "WORKER_SANDBOX_START_FAILED"
else:
    failed_gate = None
record = {
    "schema": 1, "repo": "kmjtechno/kmj-main-platform", "pr": 337,
    "sha": sha, "base_sha": base_sha, "consumer_sha": consumer_sha,
    "consumer_license_sha256": consumer_license_sha256, "runner": "kmj-codebridge-private-vps-v1",
    "github_actions": "NOT_RUN", "windows": "NOT_RUN",
    "signed_production": False, "exit_code": int(code),
    "linux_result": "PASS" if int(code) == 0 else "FAIL",
    "gate_markers": passed, "runtime_versions": runtime_versions, "log_sha256": hashlib.sha256(b).hexdigest(),
    "failure_kind": failure_kind, "failed_gate": failed_gate,
    "ended_epoch": int(time.time()),
}
pathlib.Path(output).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
PY
chmod 0600 "$manifest"
# Fixed supervisor readback: only root can update the evidence directory,
# and the consumer validates owner, mode, size, SHA and enum fields.
latest="$base/evidence/latest-pr337.json"
cp -- "$manifest" "$base/evidence/.latest-pr337.json.$$"
chmod 0600 "$base/evidence/.latest-pr337.json.$$"
mv -f -- "$base/evidence/.latest-pr337.json.$$" "$latest"
echo "KMJ_CI_SHA=$sha"
echo "KMJ_CI_LOCAL_RESULT=$([[ $code -eq 0 ]] && echo PASS || echo FAIL)"
echo "KMJ_CI_EVIDENCE=$manifest"
echo "KMJ_CI_GITHUB_ACTIONS=NOT_RUN"
echo "KMJ_CI_WINDOWS=NOT_RUN"
exit "$code"
