#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "AUTO_UPDATE_REQUIRES_ROOT" >&2; exit 2; }

REPO="https://github.com/kmjtechno/kmj-codebridge.git"
BRANCH="${CODEBRIDGE_UPDATE_BRANCH:-main}"
INSTALL_DIR="${CODEBRIDGE_INSTALL_DIR:-/opt/kmj-codebridge-agent}"
CONFIG="${CODEBRIDGE_CONFIG:-/etc/kmj-codebridge/agent.json}"
LOCK_DIR="${CODEBRIDGE_UPDATE_LOCK_DIR:-/run/kmj-codebridge-update.lock}"
MODE="${CODEBRIDGE_AUTO_UPDATE_MODE:-development}"

if [[ "$MODE" != "development" ]]; then
  echo "AUTO_UPDATE_DISABLED_FOR_MODE=$MODE"
  exit 0
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "AUTO_UPDATE_ALREADY_RUNNING"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

[[ -d "$INSTALL_DIR/.git" ]] || { echo "AUTO_UPDATE_RUNTIME_NOT_GIT" >&2; exit 3; }
[[ -r "$CONFIG" ]] || { echo "AUTO_UPDATE_CONFIG_NOT_READABLE" >&2; exit 3; }

origin="$(git -C "$INSTALL_DIR" remote get-url origin)"
[[ "$origin" == "$REPO" ]] || { echo "AUTO_UPDATE_ORIGIN_MISMATCH" >&2; exit 3; }

if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ]]; then
  echo "AUTO_UPDATE_DIRTY_RUNTIME" >&2
  exit 4
fi

current="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
remote="$(git ls-remote "$REPO" "refs/heads/$BRANCH" | awk 'NR==1{print $1}')"
[[ "$remote" =~ ^[a-f0-9]{40}$ ]] || { echo "AUTO_UPDATE_REMOTE_INVALID" >&2; exit 5; }

# Check only the fixed Main Platform systemd unit. A development updater must
# not repeatedly trigger a refresh that would overwrite a release/canary
# ExecStart. Retain the signed-promotion gate and report an explicit outcome.
main_platform_refresh_allowed() {
  local unit="kmj-codebridge-kmj-main-platform.service"
  local loaded dropins directory
  if ! loaded="$(systemctl show "$unit" -p LoadState --value 2>/dev/null)" ||
     ! dropins="$(systemctl show "$unit" -p DropInPaths --value 2>/dev/null)" ||
     ! directory="$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null)" ||
     [[ "$loaded" != "loaded" ]]; then
    echo "AUTO_UPDATE_MAIN_PLATFORM_UNIT_PREFLIGHT_UNAVAILABLE" >&2
    return 1
  fi
  if [[ "$dropins" == *"/99-kmj-release.conf"* ||
        "$dropins" == *"/zz-kmj-codebridge-development-canary.conf"* ||
        "$dropins" == *"/30-readiness-runtime.conf"* ||
        "$directory" == /opt/kmj-codebridge-releases/* ||
        "$directory" == /opt/kmj-codebridge-main-platform-agent-* ]]; then
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_DEFERRED_PROTECTED_OVERRIDE"
    return 1
  fi
  return 0
}

retry_skipped_main_platform_refresh() {
  local service="kmj-codebridge-main-platform-refresh.service"
  local current_config="/etc/kmj-codebridge-main-platform/agent.json"
  local project="/srv/kmj-codebridge-projects/kmj-main-platform"
  [[ -f "$current_config" && ! -L "$current_config" && -d "$project/.git" ]] || return 0

  # Only retry a fixed unit that was previously skipped before any process ran.
  # A successful, failed or running prior execution must not be replayed.
  local condition last_run
  condition="$(systemctl show "$service" -p ConditionResult --value 2>/dev/null || true)"
  last_run="$(systemctl show "$service" -p ExecMainStartTimestamp --value 2>/dev/null || true)"
  [[ "$condition" == "no" && -z "$last_run" ]] || return 0

  local node
  node="/opt/kmj-codebridge-node/bin/node"
  [[ -x "$node" ]] || node="$(command -v node || true)"
  [[ -n "$node" && -x "$node" ]] || {
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_NODE_UNAVAILABLE" >&2
    return 0
  }

  # Never restart another enrolled agent while its private journal has work.
  if ! CODEBRIDGE_MAIN_CONFIG="$current_config" CODEBRIDGE_MAIN_PROJECT="$project" "$node" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
const configPath = process.env.CODEBRIDGE_MAIN_CONFIG;
const meta = fs.lstatSync(configPath);
if (!meta.isFile() || meta.nlink !== 1 || meta.size > 131072) process.exit(1);
const c = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!Array.isArray(c.projects) || c.projects.length !== 1 ||
    c.projects[0].id !== "kmj-main-platform" ||
    fs.realpathSync(c.projects[0].root) !== fs.realpathSync(process.env.CODEBRIDGE_MAIN_PROJECT) ||
    c.stateDir !== "/var/lib/kmj-codebridge-kmj-main-platform") process.exit(1);
const journal = path.join(c.stateDir, "jobs");
if (fs.existsSync(journal)) {
  const info = fs.lstatSync(journal);
  if (!info.isDirectory() || info.isSymbolicLink()) process.exit(1);
  for (const name of fs.readdirSync(journal)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(journal, name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1 || st.size > 131072) process.exit(1);
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    if (job.state === "running" || job.state === "queued") process.exit(1);
  }
}
NODE
  then
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_DEFERRED" >&2
    return 0
  fi
  if ! main_platform_refresh_allowed; then
    return 0
  fi
  if systemctl start --no-block "$service"; then
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_RECOVERY_SCHEDULED=1"
  else
    echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_RECOVERY_FAILED=1" >&2
  fi
}

# Fetch only two approved review heads as the existing repository owner.
# Never execute a service-owned SSH command as the privileged updater.
refresh_fixed_private_ci_refs() {
  /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -I - <<'PY'
import fcntl, os, pwd, re, stat, subprocess

PROJECT = "/srv/kmj-codebridge-projects/kmj-main-platform"
BASE = "/var/lib/kmj-codebridge-ci"
TARGETS = [
    ("PR322", "feat/codebridge-owner-tier", "8ebbb6f1999309875b6f6b0c6d25c21847fff3ff"),
    ("PR337", "fix/public-marketing-standalone-nav-20261008", "70a5efb9a43103cd17be15d056e166cb19813efe"),
]
ORIGINS = {"git@github.com:kmjtechno/kmj-main-platform.git", "ssh://git@github.com/kmjtechno/kmj-main-platform.git", "https://github.com/kmjtechno/kmj-main-platform.git"}
ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1", "GIT_OPTIONAL_LOCKS": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_NO_REPLACE_OBJECTS": "1"}
lock_fd = None
project_fd = None
step = "PROJECT_LSTAT_READ"
try:
    try:
        project = os.lstat(PROJECT)
    except FileNotFoundError:
        step = "PROJECT_LSTAT_MISSING"
        raise
    except PermissionError:
        step = "PROJECT_LSTAT_PERMISSION_DENIED"
        raise
    except OSError:
        step = "PROJECT_LSTAT_OTHER_ERROR"
        raise
    step = "PROJECT_DIRECTORY_TYPE"
    if not stat.S_ISDIR(project.st_mode):
        step = "PROJECT_DIRECTORY_SYMLINK" if stat.S_ISLNK(project.st_mode) else "PROJECT_DIRECTORY_OTHER_TYPE"
        raise ValueError("project")
    step = "PROJECT_MODE"
    if project.st_mode & 0o002:
        if project.st_mode & 0o022 == 0o022:
            step = "PROJECT_MODE_GROUP_AND_WORLD_WRITE"
        else:
            step = "PROJECT_MODE_GROUP_WRITE" if project.st_mode & 0o020 else "PROJECT_MODE_WORLD_WRITE"
        raise ValueError("project")
    step = "PROJECT_ACCOUNT"
    owner = pwd.getpwuid(project.st_uid)
    if owner.pw_name not in {"root", "kmjrunner", "kmjprod", "kmjstage"} or project.st_gid != owner.pw_gid:
        raise ValueError("owner")
    repository_metadata = []
    for path in [PROJECT + "/.git", PROJECT + "/.git/config"]:
        step = "GIT_CONFIG" if path.endswith("/config") else "GIT_DIRECTORY"
        meta = os.lstat(path)
        regular = path.endswith("/config")
        if (not stat.S_ISREG(meta.st_mode) if regular else not stat.S_ISDIR(meta.st_mode)) or meta.st_uid != owner.pw_uid or meta.st_gid != owner.pw_gid or meta.st_mode & 0o022 or (regular and (meta.st_nlink != 1 or not 0 < meta.st_size <= 65536)):
            raise ValueError("repository metadata")
        repository_metadata.append((path, meta))
    # Root execution requires a root-owned path all the way to the filesystem.
    step = "PROJECT_PARENTS"
    parent = os.path.dirname(PROJECT)
    while True:
        meta = os.lstat(parent)
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
            raise ValueError("repository parent")
        if parent == "/":
            break
        parent = os.path.dirname(parent)
    step = "CI_DIRECTORY"
    meta = os.lstat(BASE)
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
        raise ValueError("CI directory")
    step = "CI_LOCK"
    lock_fd = os.open(BASE + "/.ci.lock", os.O_RDONLY | os.O_NOFOLLOW)
    meta = os.fstat(lock_fd)
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_nlink != 1 or meta.st_mode & 0o077:
        raise ValueError("CI lock")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("AUTO_UPDATE_PRIVATE_CI_REF_REFRESH_DEFERRED_BUSY")
        raise SystemExit(0)
    ENV["HOME"] = owner.pw_dir
    def git(*args):
        return subprocess.run(["/usr/bin/git", "-c", "safe.directory=" + PROJECT, "-c", "core.hooksPath=/dev/null", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-C", PROJECT, *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=45, env=ENV, user=owner.pw_uid, group=owner.pw_gid, extra_groups=[])
    step = "ORIGIN_READ"
    remote = git("remote", "get-url", "origin")
    if remote.returncode:
        raise ValueError("origin read")
    step = "ORIGIN_ALLOWLIST"
    if remote.stdout.strip() not in ORIGINS:
        raise ValueError("origin")
    if project.st_mode & 0o020:
        step = "PROJECT_WRITE_AUTHORITY_READ"
        authority = subprocess.run(["/usr/bin/systemctl", "show", "kmj-codebridge-kmj-main-platform.service", "--property=LoadState", "--property=User", "--no-pager"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5, env=ENV)
        fields = dict(line.split("=", 1) for line in authority.stdout.splitlines() if "=" in line)
        if authority.returncode or fields.get("LoadState") != "loaded" or "User" not in fields:
            raise ValueError("write authority unavailable")
        user = fields["User"].strip()
        if user == "":
            writer_uid = 0
        elif re.fullmatch("[0-9]{1,10}", user):
            writer_uid = pwd.getpwuid(int(user)).pw_uid
        elif re.fullmatch("[A-Za-z_][A-Za-z0-9_-]{0,63}", user):
            writer_uid = pwd.getpwnam(user).pw_uid
        else:
            raise ValueError("write authority invalid")
        step = "PROJECT_WRITE_AUTHORITY_DIFFERENT"
        if writer_uid != owner.pw_uid:
            raise ValueError("write authority differs")
        step = "PROJECT_HARDEN_IDENTITY"
        project_fd = os.open(PROJECT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        def identity(meta):
            return (meta.st_dev, meta.st_ino, meta.st_uid, meta.st_gid, meta.st_mode)
        if identity(os.fstat(project_fd)) != identity(project) or identity(os.lstat(PROJECT)) != identity(project):
            raise ValueError("project changed")
        for path, previous in repository_metadata:
            if identity(os.lstat(path)) != identity(previous):
                raise ValueError("repository metadata changed")
        step = "PROJECT_HARDEN_MODE"
        mode = stat.S_IMODE(project.st_mode) & ~0o020
        os.fchmod(project_fd, mode)
        after = os.fstat(project_fd)
        current = os.lstat(PROJECT)
        expected_identity = (project.st_dev, project.st_ino, project.st_uid, project.st_gid, stat.S_IFDIR | mode)
        if identity(after) != expected_identity or identity(current) != expected_identity:
            raise ValueError("project hardening changed")
        for path, previous in repository_metadata:
            if identity(os.lstat(path)) != identity(previous):
                raise ValueError("repository metadata changed")
        print("AUTO_UPDATE_PRIVATE_CI_PROJECT_HARDENED=1")
    for label, branch, expected in TARGETS:
        prefix = "AUTO_UPDATE_PRIVATE_" + label + "_REF_"
        tracking = "refs/remotes/origin/" + branch
        temporary = "refs/codebridge-private-ci-refresh/" + label.lower()
        fetched = None
        attempted = False
        try:
            old = git("rev-parse", "--verify", tracking)
            if old.returncode or not re.fullmatch("[a-f0-9]{40}", old.stdout.strip()):
                raise ValueError("existing tracking ref")
            old = old.stdout.strip()
            if old == expected:
                print(prefix + "CURRENT")
                continue
            exists = git("show-ref", "--verify", "--quiet", temporary)
            if exists.returncode != 1:
                raise ValueError("temporary ref exists")
            attempted = True
            result = git("fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", "refs/heads/" + branch + ":" + temporary)
            if result.returncode:
                raise ValueError("fetch")
            revision = git("rev-parse", "--verify", temporary)
            if revision.returncode or not re.fullmatch("[a-f0-9]{40}", revision.stdout.strip()):
                raise ValueError("fetched revision")
            fetched = revision.stdout.strip()
            if fetched != expected or git("merge-base", "--is-ancestor", old, expected).returncode:
                raise ValueError("unapproved or non-fast-forward head")
            if git("update-ref", tracking, expected, old).returncode:
                raise ValueError("tracking ref changed")
            print(prefix + "REFRESHED=1")
        except Exception:
            print(prefix + "REFRESH_FAILED")
        finally:
            step = "REF_CLEANUP"
            if attempted and fetched is None:
                cleanup = git("rev-parse", "--verify", temporary)
                if cleanup.returncode == 0 and re.fullmatch("[a-f0-9]{40}", cleanup.stdout.strip()):
                    fetched = cleanup.stdout.strip()
            if fetched is not None:
                git("update-ref", "-d", temporary, fetched)
except Exception:
    print("AUTO_UPDATE_PRIVATE_CI_REF_REFRESH_DEFERRED_UNTRUSTED")
    print("AUTO_UPDATE_PRIVATE_CI_REF_REFRESH_UNTRUSTED_STEP=" + step)
finally:
    if project_fd is not None:
        os.close(project_fd)
    if lock_fd is not None:
        os.close(lock_fd)
PY
}

# One fixed, user-authorized CI attempt per installed verifier and source.
# Website precedes owner; one accepted start per CURRENT request.
# This recovery uses the installed unit; no caller command, SHA or path is read.
retry_fixed_private_ci() {
  /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -I - <<'PY'
import hashlib, json, os, re, stat, subprocess, tempfile

BASE = "/var/lib/kmj-codebridge-ci"
DIRECTORY = BASE + "/evidence"
RUNTIME = "/opt/kmj-codebridge-agent"
PROJECT = "/srv/kmj-codebridge-projects/kmj-main-platform"
TARGETS = [
    ("337", "70a5efb9a43103cd17be15d056e166cb19813efe", "fix/public-marketing-standalone-nav-20261008", "ci-main-platform-pr337-fixed.sh", "ci-main-platform-pr337.sh"),
    ("322", "8ebbb6f1999309875b6f6b0c6d25c21847fff3ff", "feat/codebridge-owner-tier", "ci-main-platform-pr-fixed.sh", "ci-main-platform-pr.sh"),
]
ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1", "GIT_OPTIONAL_LOCKS": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_NO_REPLACE_OBJECTS": "1"}

def directory(path, private=False):
    meta = os.lstat(path)
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022 or (private and meta.st_mode & 0o077):
        raise ValueError("untrusted directory")

def read_root(path, limit, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_nlink != 1 or meta.st_mode & 0o022 or not 0 < meta.st_size <= limit:
            raise ValueError("untrusted file")
        if private and stat.S_IMODE(meta.st_mode) != 0o600:
            raise ValueError("untrusted marker")
        data = os.read(fd, limit + 1)
        after = os.fstat(fd)
        if len(data) != meta.st_size or after.st_size != meta.st_size or after.st_mtime_ns != meta.st_mtime_ns or after.st_ctime_ns != meta.st_ctime_ns:
            raise ValueError("changed file")
        return data
    finally:
        os.close(fd)

def run(args):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5, env=ENV)

def idle():
    for unit in ["kmj-codebridge-private-pr322-ci.service", "kmj-codebridge-private-pr337-ci.service"]:
        result = run(["/usr/bin/systemctl", "show", unit, "--property=LoadState", "--property=ActiveState", "--property=FragmentPath", "--property=DropInPaths", "--no-pager"])
        fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        if result.returncode or fields.get("LoadState") != "loaded" or fields.get("ActiveState") not in ["inactive", "failed"] or fields.get("DropInPaths"):
            return False
        if unit == UNIT and fields.get("FragmentPath") != FRAGMENT:
            return False
    return True

for label, EXPECTED, branch, wrapper, preparer in TARGETS:
    UNIT = "kmj-codebridge-private-pr" + label + "-ci.service"
    FRAGMENT = "/etc/systemd/system/" + UNIT
    MARKER = DIRECTORY + "/pr" + label + "-auto-update-scheduled.json"
    prefix = "AUTO_UPDATE_PRIVATE_PR" + label + "_CI_"
    temporary = None
    step = "BASE_DIRECTORY"
    try:
        directory(BASE)
        step = "EVIDENCE_DIRECTORY"
        directory(DIRECTORY, private=True)
        step = "RUNTIME_DIRECTORY"
        directory(RUNTIME)
        step = "SCRIPTS_DIRECTORY"
        directory(RUNTIME + "/scripts")
        step = "UNIT_FILE"
        unit_bytes = read_root(FRAGMENT, 65536)
        step = "UNIT_DEFINITION"
        unit = unit_bytes.decode("utf8")
        directives = [(key.strip(), value.strip()) for line in unit.splitlines() if "=" in line for key, value in [line.strip().split("=", 1)]]
        descriptions = [value for key, value in directives if key == "Description"]
        execution = [(key, value) for key, value in directives if key.startswith("Exec")]
        if descriptions != ["KMJ CodeBridge private PR" + label + " CI"] or execution != [("ExecStart", "/bin/bash " + RUNTIME + "/scripts/" + wrapper)]:
            raise ValueError("untrusted unit")
        step = "WORKER_FILE"
        worker = read_root(RUNTIME + "/scripts/ci-main-platform-pr-worker.sh", 524288)
        files = {"ci-main-platform-pr-worker.sh": hashlib.sha256(worker).hexdigest()}
        for script in [wrapper, preparer]:
            step = "WRAPPER_FILE" if script == wrapper else "PREPARER_FILE"
            files[script] = hashlib.sha256(read_root(RUNTIME + "/scripts/" + script, 524288)).hexdigest()
        step = "CONTROL_REVISION"
        control = run(["/usr/bin/git", "-c", "safe.directory=" + RUNTIME, "-C", RUNTIME, "rev-parse", "--verify", "HEAD"])
        if control.returncode or not re.fullmatch("[a-f0-9]{40}", control.stdout.strip()):
            raise ValueError("untrusted control revision")
        verifier = hashlib.sha256(json.dumps({"control_sha": control.stdout.strip(), "unit_sha256": hashlib.sha256(unit_bytes).hexdigest(), "files": files}, sort_keys=True).encode("utf8")).hexdigest()
        step = "SOURCE_REF_READ"
        source = run(["/usr/bin/git", "-c", "safe.directory=" + PROJECT, "-C", PROJECT, "rev-parse", "--verify", "refs/remotes/origin/" + branch])
        if source.returncode:
            raise ValueError("fixed source unavailable")
        step = "SOURCE_REF_FORMAT"
        if not re.fullmatch("[a-f0-9]{40}", source.stdout.strip()):
            raise ValueError("fixed source invalid")
        step = "SOURCE_REF_MISMATCH"
        if source.stdout.strip() != EXPECTED:
            raise ValueError("fixed source moved")
        record = {"schema": 1, "worker_sha256": files["ci-main-platform-pr-worker.sh"], "verifier_sha256": verifier, "source_sha": EXPECTED}
        if os.path.lexists(MARKER):
            step = "MARKER_FILE"
            previous_bytes = read_root(MARKER, 512, private=True)
            step = "MARKER_FORMAT"
            previous = json.loads(previous_bytes)
            if set(previous) != set(record) or previous.get("schema") != 1 or not re.fullmatch("[a-f0-9]{64}", previous.get("worker_sha256", "")) or not re.fullmatch("[a-f0-9]{40}", previous.get("source_sha", "")) or not re.fullmatch("[a-f0-9]{64}", previous.get("verifier_sha256", "")):
                raise ValueError("invalid marker")
            if previous == record:
                print(prefix + "ALREADY_SCHEDULED")
                continue
        step = "UNIT_STATE"
        if not idle():
            print(prefix + "DEFERRED_BUSY")
            raise SystemExit(0)
        step = "SHARED_LOCK"
        lock = os.lstat(BASE + "/.ci.lock")
        if not stat.S_ISREG(lock.st_mode) or lock.st_uid != 0 or lock.st_nlink != 1 or lock.st_mode & 0o077:
            raise ValueError("untrusted shared lock")
        # Probe and release before starting: holding it would make the preparer fail.
        if run(["/usr/bin/flock", "-n", BASE + "/.ci.lock", "/bin/true"]).returncode:
            print(prefix + "DEFERRED_BUSY")
            raise SystemExit(0)
        step = "MARKER_CREATE"
        fd, temporary = tempfile.mkstemp(prefix=".pr" + label + "-auto-update-", dir=DIRECTORY)
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            if os.fstat(output.fileno()).st_uid != 0:
                raise ValueError("untrusted marker owner")
            output.write((json.dumps(record, sort_keys=True) + "\n").encode("utf8"))
            output.flush()
            os.fsync(output.fileno())
        step = "UNIT_START"
        if run(["/usr/bin/systemctl", "start", "--no-block", UNIT]).returncode:
            print(prefix + "START_FAILED")
            raise SystemExit(0)
        step = "MARKER_COMMIT"
        os.replace(temporary, MARKER)
        temporary = None
        directory_fd = os.open(DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        print(prefix + "SCHEDULED=1")
        raise SystemExit(0)
    except Exception:
        print(prefix + "DEFERRED_UNTRUSTED")
        print(prefix + "UNTRUSTED_STEP=" + step)
        raise SystemExit(0)
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass
PY
}

# Recover only this fixed installer after approved refs are refreshed. Caller
# environment, arbitrary script paths and general command execution are excluded.
retry_fixed_native_ci_prerequisites() {
  if ! /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -I - <<'PREREQUISITE_META'
import os,stat
path="/opt/kmj-codebridge-agent/scripts/install-native-ci-prerequisites.sh"
try:
    m=os.lstat(path)
    if not stat.S_ISREG(m.st_mode) or m.st_uid != 0 or m.st_nlink != 1 or m.st_mode & 0o6022: raise ValueError()
    path=os.path.dirname(path)
    while True:
        m=os.lstat(path)
        if not stat.S_ISDIR(m.st_mode) or m.st_uid != 0 or m.st_mode & 0o022: raise ValueError()
        if path == '/': break
        path=os.path.dirname(path)
except (OSError, ValueError):
    raise SystemExit(3)
PREREQUISITE_META
  then
    echo AUTO_UPDATE_NATIVE_CI_PREREQUISITES_UNTRUSTED
    return 0
  fi
  if ! /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C.UTF-8 /bin/bash /opt/kmj-codebridge-agent/scripts/install-native-ci-prerequisites.sh; then
    echo AUTO_UPDATE_NATIVE_CI_PREREQUISITES_DEFERRED
  fi
}

if [[ "$current" == "$remote" ]]; then
  refresh_fixed_private_ci_refs
  retry_fixed_native_ci_prerequisites
  retry_skipped_main_platform_refresh
  retry_fixed_private_ci
  echo "AUTO_UPDATE_CURRENT=$current"
  exit 0
fi

git -C "$INSTALL_DIR" fetch --quiet --no-tags origin "$BRANCH"
fetched="$(git -C "$INSTALL_DIR" rev-parse FETCH_HEAD)"
[[ "$fetched" == "$remote" ]] || { echo "AUTO_UPDATE_FETCH_MISMATCH" >&2; exit 5; }

if ! git -C "$INSTALL_DIR" merge-base --is-ancestor "$current" "$remote"; then
  echo "AUTO_UPDATE_NON_FAST_FORWARD" >&2
  exit 6
fi

NODE="$(command -v node)"
if [[ -x "$INSTALL_DIR/../kmj-codebridge-node/bin/node" ]]; then
  NODE="$INSTALL_DIR/../kmj-codebridge-node/bin/node"
elif [[ -x /opt/kmj-codebridge-node/bin/node ]]; then
  NODE=/opt/kmj-codebridge-node/bin/node
fi
[[ -x "$NODE" ]] || { echo "AUTO_UPDATE_NODE_MISSING" >&2; exit 7; }

mapfile -d '' cfg < <("$NODE" - "$CONFIG" <<'NODE'
const fs=require("node:fs");
const c=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const p=c.projects?.[0];
if(!c.id||!p?.id||!p?.root||!c.stateDir||!c.gateway) process.exit(2);
for(const value of [c.id,p.id,p.root,c.stateDir,c.gateway]) process.stdout.write(String(value)+"\0");
NODE
)
[[ ${#cfg[@]} -eq 5 ]] || { echo "AUTO_UPDATE_CONFIG_INVALID" >&2; exit 7; }
DEVICE="${cfg[0]}"
PROJECT_ID="${cfg[1]}"
PROJECT_ROOT="${cfg[2]}"
STATE_DIR="${cfg[3]}"
GATEWAY="${cfg[4]}"
SERVICE_USER="$(stat -c '%U' "$PROJECT_ROOT")"

if "$NODE" - "$STATE_DIR" <<'NODE'
const fs=require("node:fs"),path=require("node:path");
const dir=path.join(process.argv[2],"jobs");
if(!fs.existsSync(dir)) process.exit(0);
for(const name of fs.readdirSync(dir)){
  if(!name.endsWith(".json")) continue;
  try{
    const j=JSON.parse(fs.readFileSync(path.join(dir,name),"utf8"));
    if(j.state==="running"||j.state==="queued") process.exit(9);
  }catch{}
}
NODE
then
  :
else
  code=$?
  if [[ $code -eq 9 ]]; then
    echo "AUTO_UPDATE_DEFERRED_ACTIVE_JOB"
    exit 0
  fi
  echo "AUTO_UPDATE_JOB_STATE_INVALID" >&2
  exit "$code"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

git clone -q --no-tags "$REPO" "$TMP/codebridge"
git -C "$TMP/codebridge" checkout -q "$remote"

pkg="$("$NODE" -e 'const p=require(process.argv[1]);process.stdout.write(p.name+"@"+p.version)' "$TMP/codebridge/package.json")"
[[ "$pkg" == @kmjtechno/codebridge@* ]] || { echo "AUTO_UPDATE_PACKAGE_INVALID" >&2; exit 8; }

echo "AUTO_UPDATE_FROM=$current"
echo "AUTO_UPDATE_TO=$remote"

CODEBRIDGE_GATEWAY="$GATEWAY" CODEBRIDGE_REF="$remote" CODEBRIDGE_AUTO_UPDATE_MODE=development bash "$TMP/codebridge/scripts/install-vps.sh"   --project "$PROJECT_ROOT"   --project-id "$PROJECT_ID"   --device "$DEVICE"   --service-user "$SERVICE_USER"   --ref "$remote"

MAIN_PLATFORM_REFRESH_SERVICE="kmj-codebridge-main-platform-refresh.service"
if [[ -f /etc/kmj-codebridge-main-platform/agent.json && -d /srv/kmj-codebridge-projects/kmj-main-platform/.git ]]; then
  if main_platform_refresh_allowed; then
    if systemctl start --no-block "$MAIN_PLATFORM_REFRESH_SERVICE"; then
      echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_SCHEDULED=1"
    else
      echo "AUTO_UPDATE_MAIN_PLATFORM_REFRESH_SCHEDULE_FAILED=1" >&2
    fi
  fi
fi

echo "AUTO_UPDATE_APPLIED=$remote"
