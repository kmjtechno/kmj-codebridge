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
import fcntl, grp, hashlib, os, pwd, re, stat, subprocess

PROJECT = "/srv/kmj-codebridge-projects/kmj-main-platform"
BASE = "/var/lib/kmj-codebridge-ci"
TARGETS = [
    ("PR322", "feat/codebridge-owner-tier", "d1b6f237fe85ae8516cfb3ce6d183ad3aeeb6764"),
    ("PR337", "fix/public-marketing-standalone-nav-20261008", "7718aa00dff8e505e525411b89cb4288a2b6559e"),
]
ORIGINS = {"git@github.com:kmjtechno/kmj-main-platform.git", "ssh://git@github.com/kmjtechno/kmj-main-platform.git", "https://github.com/kmjtechno/kmj-main-platform.git"}
ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1", "GIT_OPTIONAL_LOCKS": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_NO_REPLACE_OBJECTS": "1"}
lock_fd = None
harden_fds = []
parent_fds = []
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
    step = "GIT_DIRECTORY"
    # Emit only fixed metadata classes for both entries before enforcing guards.
    # A held directory descriptor prevents following a substituted .git link.
    def metadata(label, meta):
        prefix = "AUTO_UPDATE_PRIVATE_CI_" + label + "_"
        try:
            account = pwd.getpwuid(meta.st_uid)
        except KeyError:
            account = None
        owner_class = "MATCHES_PROJECT" if meta.st_uid == owner.pw_uid else "ROOT" if meta.st_uid == 0 else "TRUSTED_SERVICE" if account and account.pw_name in {"kmjrunner", "kmjprod", "kmjstage"} else "OTHER"
        group_class = "UNAVAILABLE" if account is None else "MATCHES_PRIMARY" if meta.st_gid == account.pw_gid else "DIFFERS"
        kind = "DIRECTORY" if stat.S_ISDIR(meta.st_mode) else "REGULAR" if stat.S_ISREG(meta.st_mode) else "SYMLINK" if stat.S_ISLNK(meta.st_mode) else "OTHER"
        writable = meta.st_mode & 0o022
        mode = "GROUP_AND_WORLD_WRITE" if writable == 0o022 else "GROUP_WRITE" if writable == 0o020 else "WORLD_WRITE" if writable else "NONWRITE"
        for field, value in [("OWNER", owner_class), ("GID", group_class), ("TYPE", kind), ("MODE", mode)]:
            print(prefix + field + "=" + value)
        if label == "GIT_CONFIG":
            print(prefix + "NLINK=" + ("VALID" if meta.st_nlink == 1 else "INVALID"))
            print(prefix + "SIZE=" + ("VALID" if 0 < meta.st_size <= 65536 else "INVALID"))
    def read_metadata(label, read):
        try:
            meta = read()
        except FileNotFoundError:
            result = "MISSING"
        except PermissionError:
            result = "PERMISSION_DENIED"
        except OSError:
            result = "OTHER_ERROR"
        else:
            print("AUTO_UPDATE_PRIVATE_CI_" + label + "_READ=OK")
            metadata(label, meta)
            return meta
        print("AUTO_UPDATE_PRIVATE_CI_" + label + "_READ=" + result)
        return None
    git_directory = read_metadata("GIT_DIRECTORY", lambda: os.lstat(PROJECT + "/.git"))
    git_config = None
    git_fd = None
    try:
        if git_directory is not None and stat.S_ISDIR(git_directory.st_mode):
            git_fd = os.open(PROJECT + "/.git", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            held = os.fstat(git_fd)
            state = lambda meta: (meta.st_dev, meta.st_ino, meta.st_uid, meta.st_gid, meta.st_mode)
            if state(held) != state(git_directory):
                git_directory = None
                print("AUTO_UPDATE_PRIVATE_CI_GIT_DIRECTORY_READ=CHANGED")
                print("AUTO_UPDATE_PRIVATE_CI_GIT_CONFIG_READ=BLOCKED_DIRECTORY")
            else:
                git_config = read_metadata("GIT_CONFIG", lambda: os.stat("config", dir_fd=git_fd, follow_symlinks=False))
        else:
            print("AUTO_UPDATE_PRIVATE_CI_GIT_CONFIG_READ=BLOCKED_DIRECTORY")
    except OSError:
        print("AUTO_UPDATE_PRIVATE_CI_GIT_CONFIG_READ=BLOCKED_DIRECTORY")
    finally:
        if git_fd is not None:
            os.close(git_fd)
    repository_metadata = []
    for path in [PROJECT + "/.git", PROJECT + "/.git/config"]:
        step = "GIT_CONFIG" if path.endswith("/config") else "GIT_DIRECTORY"
        meta = git_config if path.endswith("/config") else git_directory
        if meta is None:
            raise ValueError("repository metadata unavailable")
        regular = path.endswith("/config")
        if (not stat.S_ISREG(meta.st_mode) if regular else not stat.S_ISDIR(meta.st_mode)) or meta.st_uid != owner.pw_uid or meta.st_gid != owner.pw_gid or meta.st_mode & 0o002 or (regular and (meta.st_nlink != 1 or not 0 < meta.st_size <= 65536)):
            raise ValueError("repository metadata")
        repository_metadata.append((path, meta))
    # Collect all remaining fixed trust facts before the first ancestor refusal.
    for label, path in [("TRUST_PROJECT_PARENT", "/srv/kmj-codebridge-projects"), ("TRUST_SRV", "/srv"), ("TRUST_ROOT", "/")]:
        read_metadata(label, lambda path=path: os.lstat(path))
    proof_base = read_metadata("TRUST_BASE", lambda: os.lstat(BASE))
    proof_lock_fd = proof_base_fd = None
    if proof_base is None or not stat.S_ISDIR(proof_base.st_mode) or proof_base.st_uid != 0 or proof_base.st_mode & 0o022:
        print("AUTO_UPDATE_PRIVATE_CI_TRUST_LOCK_READ=BLOCKED_BASE")
    else:
        try:
            proof_base_fd = os.open(BASE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            state = lambda m: (m.st_dev, m.st_ino, m.st_uid, m.st_gid, m.st_mode, m.st_nlink)
            if state(os.fstat(proof_base_fd)) != state(proof_base):
                raise OSError("base changed")
            proof_lock_fd = os.open(".ci.lock", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=proof_base_fd)
            proof_lock = read_metadata("TRUST_LOCK", lambda: os.fstat(proof_lock_fd))
            if proof_lock is not None:
                print("AUTO_UPDATE_PRIVATE_CI_TRUST_LOCK_PRIVATE_MODE=" + ("VALID" if not proof_lock.st_mode & 0o077 else "INVALID"))
                print("AUTO_UPDATE_PRIVATE_CI_TRUST_LOCK_NLINK=" + ("VALID" if proof_lock.st_nlink == 1 else "INVALID"))
                state = lambda m: (m.st_dev, m.st_ino, m.st_uid, m.st_gid, m.st_mode, m.st_nlink)
                same = state(os.lstat(BASE)) == state(proof_base) and state(os.lstat(BASE + "/.ci.lock")) == state(proof_lock)
                print("AUTO_UPDATE_PRIVATE_CI_TRUST_LOCK_IDENTITY=" + ("MATCHES_PATH" if same else "CHANGED"))
        except FileNotFoundError:
            print("AUTO_UPDATE_PRIVATE_CI_TRUST_LOCK_READ=MISSING")
        except PermissionError:
            print("AUTO_UPDATE_PRIVATE_CI_TRUST_LOCK_READ=PERMISSION_DENIED")
        except OSError:
            print("AUTO_UPDATE_PRIVATE_CI_TRUST_LOCK_READ=OTHER_ERROR")
        finally:
            if proof_lock_fd is not None:
                os.close(proof_lock_fd)
            if proof_base_fd is not None:
                os.close(proof_base_fd)
    print("AUTO_UPDATE_PRIVATE_CI_TRUST_SOURCE_OWNER=" + ("ROOT" if owner.pw_uid == 0 else "TRUSTED_SERVICE"))
    try:
        proof_group = grp.getgrgid(owner.pw_gid)
        members = {entry.pw_uid for entry in pwd.getpwall() if entry.pw_gid == owner.pw_gid}
        members.update(pwd.getpwnam(name).pw_uid for name in proof_group.gr_mem)
        group_result = "EXCLUSIVE" if owner.pw_uid in members and members <= {0, owner.pw_uid} else "OTHER_MEMBERS"
    except (KeyError, OSError):
        group_result = "UNAVAILABLE"
    print("AUTO_UPDATE_PRIVATE_CI_TRUST_GROUP=" + group_result)
    load_result = uid_result = "UNAVAILABLE"
    try:
        proof_authority = subprocess.run(["/usr/bin/systemctl", "show", "kmj-codebridge-kmj-main-platform.service", "--property=LoadState", "--property=User", "--no-pager"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5, env=ENV)
        proof_fields = dict(line.split("=", 1) for line in proof_authority.stdout.splitlines() if "=" in line)
        if not proof_authority.returncode:
            load_result = "LOADED" if proof_fields.get("LoadState") == "loaded" else "NOT_LOADED"
            if load_result == "LOADED" and "User" in proof_fields:
                user = proof_fields["User"].strip()
                uid = 0 if user == "" else pwd.getpwuid(int(user)).pw_uid if re.fullmatch("[0-9]{1,10}", user) else pwd.getpwnam(user).pw_uid if re.fullmatch("[A-Za-z_][A-Za-z0-9_-]{0,63}", user) else None
                if uid is not None:
                    uid_result = "MATCHES_OWNER" if uid == owner.pw_uid else "DIFFERS"
    except (KeyError, OSError, subprocess.TimeoutExpired):
        pass
    print("AUTO_UPDATE_PRIVATE_CI_TRUST_WRITER_LOAD=" + load_result)
    print("AUTO_UPDATE_PRIVATE_CI_TRUST_WRITER_UID=" + uid_result)
    # The nearest parent may belong to the already-authorized source owner.
    # Upper ancestors remain root-owned; no shared directory is modified.
    step = "PROJECT_PARENTS"
    def parent_identity(meta):
        return (meta.st_dev, meta.st_ino, meta.st_uid, meta.st_gid, meta.st_mode, meta.st_nlink, meta.st_size, meta.st_mtime_ns, meta.st_ctime_ns)
    for index, parent in enumerate(["/srv/kmj-codebridge-projects", "/srv", "/"]):
        meta = os.lstat(parent)
        allowed = {0, owner.pw_uid} if index == 0 else {0}
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid not in allowed or meta.st_mode & 0o022:
            raise ValueError("repository parent")
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        parent_fds.append((parent, meta, fd))
        if parent_identity(os.fstat(fd)) != parent_identity(meta):
            raise ValueError("repository parent changed")
    def verify_parents():
        for path, previous, fd in parent_fds:
            if parent_identity(os.fstat(fd)) != parent_identity(previous) or parent_identity(os.lstat(path)) != parent_identity(previous):
                raise ValueError("repository parent changed")
    verify_parents()
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
    entries = [(PROJECT, project), *repository_metadata]
    needs_hardening = any(meta.st_mode & 0o020 for _, meta in entries)
    if needs_hardening:
        step = "PROJECT_GROUP_EXCLUSIVITY"
        group = grp.getgrgid(owner.pw_gid)
        members = {account.pw_uid for account in pwd.getpwall() if account.pw_gid == owner.pw_gid}
        members.update(pwd.getpwnam(name).pw_uid for name in group.gr_mem)
        if owner.pw_uid not in members or members - {0, owner.pw_uid}:
            raise ValueError("other group writer")
    ENV["HOME"] = owner.pw_dir
    def git(*args):
        verify_parents()
        return subprocess.run(["/usr/bin/git", "-c", "safe.directory=" + PROJECT, "-c", "core.hooksPath=/dev/null", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-C", PROJECT, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=45, env=ENV, user=owner.pw_uid, group=owner.pw_gid, extra_groups=[])
    step = "ORIGIN_READ"
    remote = git("remote", "get-url", "origin")
    if remote.returncode:
        raise ValueError("origin read")
    step = "ORIGIN_ALLOWLIST"
    if remote.stdout.strip() not in ORIGINS:
        raise ValueError("origin")
    # Repair only the proved legacy root-private website tracking pair.
    # No shared ref directories, other refs, modes or contents are changed.
    def repair_fixed_tracking_metadata(reflog=False):
        global step
        if owner.pw_uid == 0:
            return
        descriptors = []
        ancestors = []
        changed = False
        leaf = "public-marketing-standalone-nav-20261008"
        components = ["logs", "refs", "remotes", "origin"] if reflog else ["refs", "remotes", "origin"]
        directory_path = PROJECT + "/.git/" + "/".join(components) + "/fix"
        repair_prefix = "AUTO_UPDATE_PRIVATE_PR337_" + ("REFLOG_METADATA_" if reflog else "REF_METADATA_")
        ref_path = directory_path + "/" + leaf
        old_ref = b"05d1c69eddb3c47854362f5681ebe7ebf3dd7e51\n"
        try:
            step = "REF_METADATA_IDENTITY"
            current = os.open(PROJECT + "/.git", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptors.append(current)
            if parent_identity(os.fstat(current)) != parent_identity(git_directory):
                raise ValueError("repository descriptor changed")
            ancestor_path = PROJECT + "/.git"
            ancestors.append((ancestor_path, current, git_directory))
            for component in components:
                meta = os.stat(component, dir_fd=current, follow_symlinks=False)
                if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != owner.pw_uid or meta.st_gid != owner.pw_gid or meta.st_mode & 0o002:
                    raise ValueError("ref ancestor")
                following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                descriptors.append(following)
                if parent_identity(os.fstat(following)) != parent_identity(meta):
                    raise ValueError("ref ancestor changed")
                ancestor_path += "/" + component
                ancestors.append((ancestor_path, following, meta))
                current = following
            directory = os.stat("fix", dir_fd=current, follow_symlinks=False)
            if not stat.S_ISDIR(directory.st_mode):
                raise ValueError("ref directory")
            directory_fd = os.open("fix", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            descriptors.append(directory_fd)
            ref = os.stat(leaf, dir_fd=directory_fd, follow_symlinks=False)
            if directory.st_uid == owner.pw_uid and ref.st_uid == owner.pw_uid:
                return
            step = "REF_METADATA_OWNER"
            if directory.st_uid != 0 or directory.st_gid != 0 or stat.S_IMODE(directory.st_mode) != 0o700:
                raise ValueError("unproven ref directory owner")
            allowed_ref_owner = (ref.st_uid == 0 and ref.st_gid == 0) or (ref.st_uid == owner.pw_uid and ref.st_gid == owner.pw_gid)
            size_valid = 0 < ref.st_size <= 8388608 if reflog else ref.st_size == len(old_ref)
            if not allowed_ref_owner or not stat.S_ISREG(ref.st_mode) or stat.S_IMODE(ref.st_mode) != 0o600 or ref.st_nlink != 1 or not size_valid:
                raise ValueError("unproven ref file")
            ref_fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            descriptors.append(ref_fd)
            entries = [(directory_path, directory_fd, directory), (ref_path, ref_fd, ref)]
            snapshots = [directory, ref]
            # Preserve opaque history; never print its bytes, actors or messages.
            def digest_content(validate=False):
                data = os.pread(ref_fd, ref.st_size + 1, 0)
                if len(data) != ref.st_size:
                    raise ValueError("ref content size changed")
                if validate:
                    if reflog:
                        lines = data.splitlines(keepends=True)
                        if not lines or any(len(line) > 65536 or not re.fullmatch(rb"[0-9a-f]{40} [0-9a-f]{40} [^\x00\r\n\t]+\t[^\x00\r\n]*\n", line) for line in lines) or lines[-1][41:81] != old_ref[:40]:
                            raise ValueError("unproven reflog history")
                    elif data != old_ref:
                        raise ValueError("unproven ref content")
                return hashlib.sha256(data).digest()
            def verify_identity():
                verify_parents()
                for path, fd, previous in ancestors:
                    if parent_identity(os.fstat(fd)) != parent_identity(previous) or parent_identity(os.lstat(path)) != parent_identity(previous):
                        raise ValueError("ref ancestor changed")
                for (path, fd, _), previous in zip(entries, snapshots):
                    if parent_identity(os.fstat(fd)) != parent_identity(previous) or parent_identity(os.lstat(path)) != parent_identity(previous):
                        raise ValueError("ref pair changed")
                if os.listdir(directory_fd) != [leaf]:
                    raise ValueError("ref pair children")
            verify_identity()
            content_digest = digest_content(validate=True)
            def verify_pair():
                verify_identity()
                if digest_content() != content_digest:
                    raise ValueError("ref pair content")
            step = "REF_METADATA_CONTENT"
            verify_pair()
            step = "REF_METADATA_GROUP"
            group = grp.getgrgid(owner.pw_gid)
            members = {account.pw_uid for account in pwd.getpwall() if account.pw_gid == owner.pw_gid}
            members.update(pwd.getpwnam(name).pw_uid for name in group.gr_mem)
            if owner.pw_uid not in members or not members <= {0, owner.pw_uid}:
                raise ValueError("ref owner group shared")
            step = "REF_METADATA_WRITER"
            authority = subprocess.run(["/usr/bin/systemctl", "show", "kmj-codebridge-kmj-main-platform.service", "--property=LoadState", "--property=User", "--no-pager"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5, env=ENV)
            fields = dict(line.split("=", 1) for line in authority.stdout.splitlines() if "=" in line)
            if authority.returncode or fields.get("LoadState") != "loaded" or "User" not in fields:
                raise ValueError("ref writer unavailable")
            user = fields["User"].strip()
            writer = 0 if user == "" else pwd.getpwuid(int(user)).pw_uid if re.fullmatch("[0-9]{1,10}", user) else pwd.getpwnam(user).pw_uid if re.fullmatch("[A-Za-z_][A-Za-z0-9_-]{0,63}", user) else None
            if writer != owner.pw_uid:
                raise ValueError("ref writer differs")
            # Transfer the leaf first: source traversal is granted only last.
            step = "REF_METADATA_IDENTITY"
            for index in [1, 0]:
                verify_pair()
                path, fd, previous = entries[index]
                if previous.st_uid != owner.pw_uid:
                    os.fchown(fd, owner.pw_uid, owner.pw_gid)
                    changed = True
                    after = os.fstat(fd)
                    before_state = parent_identity(previous)
                    expected = (*before_state[:2], owner.pw_uid, owner.pw_gid, *before_state[4:-1])
                    if parent_identity(after)[:-1] != expected:
                        raise ValueError("ref owner transfer changed invariants")
                    snapshots[index] = after
            verify_pair()
            if changed:
                print(repair_prefix + "REPAIRED=1")
        except FileNotFoundError:
            if not reflog or changed:
                if changed:
                    print(repair_prefix + "REPAIR_INCOMPLETE")
                raise
        except Exception:
            if changed:
                print(repair_prefix + "REPAIR_INCOMPLETE")
            raise
        finally:
            for fd in reversed(descriptors):
                os.close(fd)
    repair_fixed_tracking_metadata()
    repair_fixed_tracking_metadata(reflog=True)
    if needs_hardening:
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
        def identity(meta):
            return (meta.st_dev, meta.st_ino, meta.st_uid, meta.st_gid, meta.st_mode, meta.st_nlink, meta.st_size, meta.st_mtime_ns, meta.st_ctime_ns)
        for index, (path, previous) in enumerate(entries):
            if index < 2:
                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            else:
                fd = os.open("config", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=harden_fds[1])
            harden_fds.append(fd)
            if identity(os.fstat(fd)) != identity(previous):
                raise ValueError("metadata descriptor changed")
        # Validate all three paths before changing even one permission bit.
        for path, previous in entries:
            if identity(os.lstat(path)) != identity(previous):
                raise ValueError("metadata path changed")
        verify_parents()
        step = "PROJECT_HARDEN_MODE"
        for (_, previous), fd in zip(entries, harden_fds):
            if previous.st_mode & 0o020:
                os.fchmod(fd, stat.S_IMODE(previous.st_mode) & ~0o020)
        for (path, previous), fd in zip(entries, harden_fds):
            expected = identity(previous)[:-1]
            expected = (*expected[:4], previous.st_mode & ~0o020, *expected[5:])
            if identity(os.fstat(fd))[:-1] != expected or identity(os.lstat(path))[:-1] != expected:
                raise ValueError("metadata hardening changed")
        if project.st_mode & 0o020:
            print("AUTO_UPDATE_PRIVATE_CI_PROJECT_HARDENED=1")
        if git_directory.st_mode & 0o020 or git_config.st_mode & 0o020:
            print("AUTO_UPDATE_PRIVATE_CI_GIT_METADATA_HARDENED=1")
    def tracking_access_proof(fetch_failure=False):
        paths = [
            ("REF_ROOT", PROJECT + "/.git/refs"),
            ("REF_REMOTES", PROJECT + "/.git/refs/remotes"),
            ("REF_ORIGIN", PROJECT + "/.git/refs/remotes/origin"),
            ("REF_FIX_PARENT", PROJECT + "/.git/refs/remotes/origin/fix"),
            ("REF_WEBSITE", PROJECT + "/.git/refs/remotes/origin/fix/public-marketing-standalone-nav-20261008"),
            ("REF_PACKED", PROJECT + "/.git/packed-refs"),
            ("OBJECT_ROOT", PROJECT + "/.git/objects"),
            ("OBJECT_PACK", PROJECT + "/.git/objects/pack"),
            ("OBJECT_INFO", PROJECT + "/.git/objects/info"),
        ]
        if fetch_failure:
            paths = [
                ("REF_ROOT", PROJECT + "/.git/refs"),
                ("REF_TEMP_ROOT", PROJECT + "/.git/refs/codebridge-private-ci-refresh"),
                ("REF_TEMP_PR337", PROJECT + "/.git/refs/codebridge-private-ci-refresh/pr337"),
                ("REF_TEMP_PR322", PROJECT + "/.git/refs/codebridge-private-ci-refresh/pr322"),
                ("REF_LOG_ROOT", PROJECT + "/.git/logs"),
                ("REF_LOG_REFS", PROJECT + "/.git/logs/refs"),
                ("REF_LOG_REMOTES", PROJECT + "/.git/logs/refs/remotes"),
                ("REF_LOG_ORIGIN", PROJECT + "/.git/logs/refs/remotes/origin"),
                ("REF_LOG_FIX", PROJECT + "/.git/logs/refs/remotes/origin/fix"),
                ("REF_LOG_WEBSITE", PROJECT + "/.git/logs/refs/remotes/origin/fix/public-marketing-standalone-nav-20261008"),
                ("REF_LOG_TEMP_ROOT", PROJECT + "/.git/logs/refs/codebridge-private-ci-refresh"),
                ("REF_LOG_TEMP_PR337", PROJECT + "/.git/logs/refs/codebridge-private-ci-refresh/pr337"),
                ("REF_LOG_TEMP_PR322", PROJECT + "/.git/logs/refs/codebridge-private-ci-refresh/pr322"),
            ]
        proof_fds = []
        root_fd = None
        try:
            root_fd = os.open(PROJECT + "/.git", os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            proof_fds.append(root_fd)
            held = os.fstat(root_fd)
            if (held.st_dev, held.st_ino, held.st_uid, held.st_gid) != (git_directory.st_dev, git_directory.st_ino, owner.pw_uid, owner.pw_gid):
                raise OSError("repository changed")
        except OSError:
            root_fd = None
        directories = {"": root_fd}
        try:
            for label, path in paths:
                relative = path[len(PROJECT + "/.git/"):]
                parent = relative.rsplit("/", 1)[0] if "/" in relative else ""
                component = relative.rsplit("/", 1)[-1]
                current = directories.get(parent)
                if current is None:
                    print("AUTO_UPDATE_PRIVATE_CI_" + label + "_READ=BLOCKED_DIRECTORY")
                    continue
                meta = read_metadata(label, lambda component=component, current=current: os.stat(component, dir_fd=current, follow_symlinks=False))
                if label in {"REF_WEBSITE", "REF_PACKED", "REF_TEMP_PR337", "REF_TEMP_PR322", "REF_LOG_WEBSITE", "REF_LOG_TEMP_PR337", "REF_LOG_TEMP_PR322"} and meta is not None:
                    print("AUTO_UPDATE_PRIVATE_CI_" + label + "_NLINK=" + ("VALID" if meta.st_nlink == 1 else "INVALID"))
                    print("AUTO_UPDATE_PRIVATE_CI_" + label + "_SIZE=" + ("VALID" if 0 < meta.st_size <= 8388608 else "INVALID"))
                if meta is not None and stat.S_ISDIR(meta.st_mode):
                    try:
                        next_fd = os.open(component, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                        proof_fds.append(next_fd)
                        held = os.fstat(next_fd)
                        identity = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid, value.st_mode)
                        if identity(held) == identity(meta):
                            directories[relative] = next_fd
                        else:
                            print("AUTO_UPDATE_PRIVATE_CI_" + label + "_READ=CHANGED")
                    except OSError:
                        print("AUTO_UPDATE_PRIVATE_CI_" + label + "_READ=BLOCKED_DIRECTORY")
        finally:
            for fd in reversed(proof_fds):
                os.close(fd)
        # Fixed read-only probe uses exactly Git's source UID and primary group.
        probe = "import os,stat\npaths=" + repr(paths) + "\n" + """fds=[]
repository='/srv/kmj-codebridge-projects/kmj-main-platform/.git'
root=None
try:
    root=os.open(repository,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW)
    fds.append(root)
except OSError:
    pass
directories={'':root}
try:
    for label,path in paths:
        relative=path[len(repository)+1:]
        parent=relative.rsplit('/',1)[0] if '/' in relative else ''
        component=relative.rsplit('/',1)[-1]
        current=directories.get(parent)
        access=write='BLOCKED_DIRECTORY'
        if current is not None:
            try:
                meta=os.stat(component,dir_fd=current,follow_symlinks=False)
                if stat.S_ISLNK(meta.st_mode):
                    access=write='SYMLINK'
                elif stat.S_ISDIR(meta.st_mode) or stat.S_ISREG(meta.st_mode):
                    requested=os.X_OK if stat.S_ISDIR(meta.st_mode) else os.R_OK
                    access='ALLOWED' if os.access(component,requested,dir_fd=current,follow_symlinks=False) else 'DENIED'
                    write='ALLOWED' if os.access(component,os.W_OK,dir_fd=current,follow_symlinks=False) else 'DENIED'
                else:
                    access=write='OTHER_TYPE'
                if stat.S_ISDIR(meta.st_mode):
                    descriptor=os.open(component,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current)
                    fds.append(descriptor)
                    directories[relative]=descriptor
            except FileNotFoundError: access=write='MISSING'
            except PermissionError: access=write='PERMISSION_DENIED'
            except OSError: access=write='OTHER_ERROR'
        print(label+'_ACCESS='+access)
        print(label+'_WRITE_ACCESS='+write)
finally:
    for fd in reversed(fds): os.close(fd)
"""
        values = ["ALLOWED", "DENIED", "SYMLINK", "OTHER_TYPE", "MISSING", "PERMISSION_DENIED", "OTHER_ERROR", "BLOCKED_DIRECTORY"]
        allowed = {label + "_" + field + "=" + value for label, _ in paths for field in ["ACCESS", "WRITE_ACCESS"] for value in values}
        try:
            verify_parents()
            access = subprocess.run(["/usr/bin/python3", "-I", "-c", probe], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5, env=ENV, user=owner.pw_uid, group=owner.pw_gid, extra_groups=[])
            if access.returncode:
                raise ValueError("access probe")
            for line in access.stdout.splitlines():
                if line in allowed:
                    print("AUTO_UPDATE_PRIVATE_CI_" + line)
        except Exception:
            print("AUTO_UPDATE_PRIVATE_CI_REF_ACCESS_PROBE=UNAVAILABLE")
    for label, branch, expected in TARGETS:
        prefix = "AUTO_UPDATE_PRIVATE_" + label + "_REF_"
        tracking = "refs/remotes/origin/" + branch
        temporary = "refs/codebridge-private-ci-refresh/" + label.lower()
        fetched = None
        attempted = False
        operation = "TRACKING_REF_READ"
        result = None
        def report_failure(stage, response=None, exception=None):
            code = "TIMEOUT" if isinstance(exception, subprocess.TimeoutExpired) else "EXCEPTION" if exception is not None else "NO_EXIT" if response is None else "EXIT_0" if response.returncode == 0 else "EXIT_1" if response.returncode == 1 else "EXIT_128" if response.returncode == 128 else "SIGNAL" if response.returncode < 0 else "OTHER_NONZERO"
            # Only the first4096 characters influence a fixed public category.
            error = (getattr(response, "stderr", "") or "")[:4096].lower()
            kind = "UNCLASSIFIED"
            for category, patterns in [
                ("OBJECT_READ_FAILED", ["bad object", "unable to read", "failed to read object"]),
                ("REVISION_UNAVAILABLE", ["needed a single revision", "unknown revision or path not in the working tree"]),
                ("KEY_PERMISSIONS", ["are too open", "bad owner or permissions", "bad permissions"]),
                ("PUBLICKEY_DENIED", ["permission denied (publickey"]),
                ("HOSTKEY_VERIFICATION_FAILED", ["host key verification failed", "remote host identification has changed"]),
                ("DNS_FAILED", ["could not resolve hostname", "could not resolve host:"]),
                ("NETWORK_UNREACHABLE", ["network is unreachable", "connection timed out", "connection refused"]),
                ("GIT_PERMISSION_DENIED", ["permission denied", "operation not permitted"]),
                ("REMOTE_REF_MISSING", ["couldn't find remote ref"]),
                ("GIT_LOCK_FAILED", ["cannot lock ref", "unable to create", "file exists"]),
            ]:
                if any(pattern in error for pattern in patterns):
                    kind = category
                    break
            target = "UNCLASSIFIED"
            for category, pattern in [
                ("WEBSITE_REFLOG", "logs/refs/remotes/origin/fix/public-marketing-standalone-nav-20261008"),
                ("TEMPORARY_REFLOG", "logs/refs/codebridge-private-ci-refresh"),
                ("TEMPORARY_REF", "refs/codebridge-private-ci-refresh"),
                ("OBJECT_STORAGE", ".git/objects"),
            ]:
                if pattern in error:
                    target = category
                    break
            for field, value in [("STAGE", stage), ("EXIT", code), ("KIND", kind), ("TARGET", target)]:
                print(prefix + "FAILURE_" + field + "=" + value)
        try:
            result = git("rev-parse", "--verify", tracking)
            if result.returncode or not re.fullmatch("[a-f0-9]{40}", result.stdout.strip()):
                raise ValueError("existing tracking ref")
            old = result.stdout.strip()
            if old == expected:
                print(prefix + "CURRENT")
                continue
            operation = "TEMPORARY_REF_READ"
            result = git("show-ref", "--verify", "--quiet", temporary)
            if result.returncode != 1:
                if result.returncode == 0:
                    operation = "TEMPORARY_REF_EXISTS"
                raise ValueError("temporary ref unavailable")
            attempted = True
            operation = "FETCH"
            result = git("fetch", "--refmap=", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", "refs/heads/" + branch + ":" + temporary)
            if result.returncode:
                raise ValueError("fetch")
            operation = "FETCHED_REF_READ"
            result = git("rev-parse", "--verify", temporary)
            if result.returncode or not re.fullmatch("[a-f0-9]{40}", result.stdout.strip()):
                raise ValueError("fetched revision")
            fetched = result.stdout.strip()
            operation = "EXPECTED_SHA"
            if fetched != expected:
                raise ValueError("unapproved head")
            operation = "ANCESTRY"
            result = git("merge-base", "--is-ancestor", old, expected)
            if result.returncode:
                raise ValueError("non-fast-forward head")
            operation = "TRACKING_REF_CAS"
            result = git("update-ref", tracking, expected, old)
            if result.returncode:
                raise ValueError("tracking ref changed")
            print(prefix + "REFRESHED=1")
        except Exception as failure:
            print(prefix + "REFRESH_FAILED")
            report_failure(operation, result, failure if not isinstance(failure, ValueError) else None)
            if operation == "TRACKING_REF_READ":
                tracking_access_proof()
            elif operation in {"FETCH", "TRACKING_REF_CAS"}:
                tracking_access_proof(fetch_failure=True)
        finally:
            step = "REF_CLEANUP"
            cleanup_operation = "CLEANUP_REF_READ"
            cleanup = None
            try:
                if attempted and fetched is None:
                    cleanup = git("rev-parse", "--verify", temporary)
                    if cleanup.returncode == 0 and re.fullmatch("[a-f0-9]{40}", cleanup.stdout.strip()):
                        fetched = cleanup.stdout.strip()
                    else:
                        report_failure(cleanup_operation, cleanup)
                if fetched is not None:
                    cleanup_operation = "CLEANUP_REF_CAS"
                    cleanup = git("update-ref", "-d", temporary, fetched)
                    if cleanup.returncode:
                        report_failure(cleanup_operation, cleanup)
            except Exception as failure:
                report_failure(cleanup_operation, cleanup, failure)
except Exception:
    print("AUTO_UPDATE_PRIVATE_CI_REF_REFRESH_DEFERRED_UNTRUSTED")
    print("AUTO_UPDATE_PRIVATE_CI_REF_REFRESH_UNTRUSTED_STEP=" + step)
finally:
    for _, _, fd in reversed(parent_fds):
        os.close(fd)
    for fd in reversed(harden_fds):
        os.close(fd)
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
    ("337", "7718aa00dff8e505e525411b89cb4288a2b6559e", "fix/public-marketing-standalone-nav-20261008", "ci-main-platform-pr337-fixed.sh", "ci-main-platform-pr337.sh"),
    ("322", "d1b6f237fe85ae8516cfb3ce6d183ad3aeeb6764", "feat/codebridge-owner-tier", "ci-main-platform-pr-fixed.sh", "ci-main-platform-pr.sh"),
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
