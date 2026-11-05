#!/usr/bin/env python3
"""Fixed, operator-installed Main Platform production release controller.

No CLI arguments, no environment-dependent targets, no shell invocation.
Must be launched only by kmj-main-platform-production-release.service.
A reviewed release is staged under /home/kmjprod/releases/platform-<sha12>.
The root-owned approval AND verified prior backup are required.
"""
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path("/home/kmjprod")
RELEASES = ROOT / "releases"
CURRENT = ROOT / "current"
PREVIOUS = ROOT / "previous"
APPROVAL = Path("/etc/kmj-codebridge/main-platform-production-release.json")
BACKUP_ROOT = Path("/var/backups/kmj-platform")
LOCK = Path("/run/lock/kmj-main-platform-production-release.lock")
SHA_PATTERN = re.compile(r"^[a-f0-9]{40}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
RELEASE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{3,100}$")
ORIGIN = "https://kmjtechno.com"
SERVICE_USER = "kmjprod"


def stop(message):
    raise RuntimeError(message)


def protected_regular(path):
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != 0
        or info.st_nlink != 1
        or (info.st_mode & 0o022)
    ):
        stop("PROTECTED_FILE_UNSAFE")
    return info


def read_approved():
    protected_regular(APPROVAL)
    if APPROVAL.stat().st_size > 4096:
        stop("APPROVAL_TOO_LARGE")
    data = json.loads(APPROVAL.read_text(encoding="utf-8"))
    if (
        not isinstance(data, dict)
        or set(data) != {
            "approvedSha",
            "expectedCurrentRelease",
            "backupVerified",
            "rollbackVerified",
        }
        or not isinstance(data["approvedSha"], str)
        or SHA_PATTERN.fullmatch(data["approvedSha"]) is None
        or not isinstance(data["expectedCurrentRelease"], str)
        or RELEASE_PATTERN.fullmatch(data["expectedCurrentRelease"]) is None
        or data["backupVerified"] is not True
        or data["rollbackVerified"] is not True
    ):
        stop("APPROVAL_INVALID")
    return data


def release_symlink():
    if not CURRENT.is_symlink():
        stop("PRODUCTION_POINTER_NOT_SYMLINK")
    target = os.readlink(CURRENT)
    match = re.fullmatch(
        r"(?:/home/kmjprod/)?releases/([a-z0-9][a-z0-9_-]{3,100})", target
    )
    if match is None:
        stop("PRODUCTION_POINTER_OUTSIDE_RELEASES")
    if not (RELEASES / match.group(1)).is_dir():
        stop("CURRENT_RELEASE_MISSING")
    return match.group(1), target


def run(*args, capture=False):
    result = subprocess.run(
        list(args),
        check=False,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=60,
        text=True,
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": "/root",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_OPTIONAL_LOCKS": "0",
        },
    )
    if result.returncode != 0:
        stop("RELEASE_PRECHECK_FAILED")
    return result.stdout.strip() if capture else None


def services_ok():
    for unit in ("nginx.service", "php8.4-fpm.service"):
        run("/usr/bin/systemctl", "is-active", "--quiet", unit)


def verify_backup(sha, old_release):
    witness = BACKUP_ROOT / ("pre-deploy-" + sha[:12] + ".json")
    protected_regular(witness)
    if witness.stat().st_size > 4096:
        stop("BACKUP_WITNESS_INVALID")
    record = json.loads(witness.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or set(record) != {
        "approvedSha",
        "currentRelease",
        "backupSha256",
    }:
        stop("BACKUP_WITNESS_INVALID")
    if (
        record["approvedSha"] != sha
        or record["currentRelease"] != old_release
        or not isinstance(record["backupSha256"], str)
        or SHA256_PATTERN.fullmatch(record["backupSha256"]) is None
    ):
        stop("BACKUP_WITNESS_MISMATCH")
    backup = BACKUP_ROOT / ("pre-deploy-" + sha[:12] + ".tar.gz")
    protected_regular(backup)
    digest = hashlib.sha256()
    with backup.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != record["backupSha256"]:
        stop("BACKUP_CHECKSUM_MISMATCH")


# --- Preserved pre-shared storage directory --------------------------------------------------------------
# The reviewed storage switch (main platform scripts/operations/main_platform_storage_switch.py) leaves the
# original storage tree beside the symlink as apps/platform/storage.pre-shared-<UTC stamp>/. Git sees it as
# untracked. Exactly ONE such name is exempted from the cleanliness scan, and only with journal + content +
# Git evidence. Keep the plan-id format byte-compatible with the switch tool (parity vector in tests).
STORAGE_STATE = Path("/var/lib/kmj-main-platform-storage-switch")
STATE_OWNER_UIDS = (0,)
PRESERVED_NAME = re.compile(r"\Astorage\.pre-shared-\d{8}T\d{6}Z\Z")
PRESERVED_LINK = re.compile(r"\A\.kmj-storage-link-[0-9a-f]{16}\Z")
PRESERVED_PHASES = {"begin", "live_frozen", "both_frozen", "link_created", "exchanged", "preserved", "verified", "complete"}
PLAN_HEX = re.compile(r"\A[0-9a-f]{16}\Z")
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def _receipt_entries(directory_fd, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory_fd)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid not in STATE_OWNER_UIDS
            or stat.S_IMODE(info.st_mode) & 0o077
            or info.st_size > 65536
        ):
            return None
        raw = os.read(fd, 65537)
    finally:
        os.close(fd)
    if not raw.endswith(b"\n"):
        return None  # unterminated tail: not a closed receipt
    entries = []
    try:
        for line in raw.decode("utf-8", "strict").splitlines():
            entry = json.loads(line)
            phase = entry.get("phase") if isinstance(entry, dict) else None
            if not isinstance(entry.get("t"), int) or not (
                phase in PRESERVED_PHASES or (isinstance(phase, str) and phase.startswith("rollback_"))
            ):
                return None
            if "kept" in entry and not (isinstance(entry["kept"], str) and PRESERVED_NAME.match(entry["kept"])):
                return None
            if "link" in entry and not (isinstance(entry["link"], str) and PRESERVED_LINK.match(entry["link"])):
                return None
            for key in ("plan", "shared_plan"):
                if key in entry and not (isinstance(entry[key], str) and PLAN_HEX.match(entry[key])):
                    return None
            entries.append(entry)
    except (ValueError, AttributeError, RecursionError):
        return None
    return entries or None


def _storage_plan_id(directory_fd):
    """sha256[:16] over persistent-class files and persistent directory metadata (same bytes as the switch tool)."""
    files, dirs, count = {}, {}, [0]

    def no_xattr(fd):
        try:
            if os.listxattr(fd):
                stop("PRESERVED_STORAGE_XATTR")
        except OSError as error:
            if error.errno not in (95, 61):
                stop("PRESERVED_STORAGE_XATTR_UNREADABLE")

    def visit(fd, prefix):
        for name in sorted(os.listdir(fd)):
            count[0] += 1
            if count[0] > 20000:
                stop("PRESERVED_STORAGE_TOO_LARGE")
            rel = prefix + name
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, _DIR_FLAGS, dir_fd=fd)
                try:
                    opened = os.fstat(child)
                    if opened.st_ino != info.st_ino:
                        stop("PRESERVED_STORAGE_SWAPPED")
                    no_xattr(child)
                    dirs[rel] = (stat.S_IMODE(opened.st_mode), opened.st_uid, opened.st_gid)
                    visit(child, rel + "/")
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                if name == ".gitignore" or name.startswith(".kmj-tmp-"):
                    continue
                if info.st_nlink != 1 or info.st_size > 8 * 1024**3:
                    stop("PRESERVED_STORAGE_UNSAFE_FILE")
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
                try:
                    opened = os.fstat(child)
                    if (opened.st_ino, opened.st_size) != (info.st_ino, info.st_size):
                        stop("PRESERVED_STORAGE_SWAPPED")
                    no_xattr(child)
                    digest, left = hashlib.sha256(), opened.st_size
                    while left:
                        block = os.read(child, min(left, 1 << 20))
                        if not block:
                            stop("PRESERVED_STORAGE_SHORT_READ")
                        left -= len(block)
                        digest.update(block)
                    after = os.fstat(child)
                    if (opened.st_mtime_ns, opened.st_size) != (after.st_mtime_ns, after.st_size):
                        stop("PRESERVED_STORAGE_CHANGED")
                finally:
                    os.close(child)
                files[rel] = (digest.hexdigest(), info.st_size, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
            else:
                stop("PRESERVED_STORAGE_SPECIAL_ENTRY")

    no_xattr(directory_fd)
    visit(directory_fd, "")

    def persistent(rel):
        return not rel.startswith(("framework/views/", "framework/cache/", "logs/"))

    view = [
        sorted((r, m) for r, m in files.items() if persistent(r)),
        sorted((r, m) for r, m in dirs.items() if persistent(r + "/")),
    ]
    return hashlib.sha256(json.dumps(view).encode()).hexdigest()[:16]


def preserved_storage_name(release):
    """None when the release has no preserved storage directory; the exact attested name otherwise.
    Any unattested entry stops the activation (fail closed)."""
    app = release / "apps/platform"
    names = sorted(entry for entry in os.listdir(app) if entry.startswith("storage.pre-shared-"))
    if not names:
        return None
    if len(names) != 1 or not PRESERVED_NAME.match(names[0]):
        stop("CANDIDATE_PRESERVED_STORAGE_UNATTESTED")
    name = names[0]
    info = os.lstat(app / name)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid not in trusted_uids()
        or (info.st_mode & 0o022)
    ):
        stop("CANDIDATE_PRESERVED_STORAGE_UNATTESTED")
    try:
        state_fd = os.open(STORAGE_STATE, _DIR_FLAGS)
    except OSError:
        stop("CANDIDATE_PRESERVED_STORAGE_UNATTESTED")
    try:
        state = os.fstat(state_fd)
        if state.st_uid not in STATE_OWNER_UIDS or stat.S_IMODE(state.st_mode) & 0o077:
            stop("CANDIDATE_PRESERVED_STORAGE_UNATTESTED")
        key = hashlib.sha256(os.path.realpath(app).encode()).hexdigest()[:12]
        files = os.listdir(state_fd)
        if key + ".journal" in files:
            stop("CANDIDATE_PRESERVED_STORAGE_UNATTESTED")  # a storage transaction is still open
        plan = None
        for receipt in sorted(entry for entry in files if entry.startswith(key + ".journal.done-")):
            entries = _receipt_entries(state_fd, receipt)
            if entries is None:
                continue
            if any(e["phase"].startswith("rollback_") and e.get("kept") == name for e in entries):
                stop("CANDIDATE_PRESERVED_STORAGE_UNATTESTED")
            phases = [e["phase"] for e in entries]
            begin = next((e for e in entries if e["phase"] == "begin"), None)
            if (
                begin is not None
                and begin.get("kept") == name
                and "plan" in begin
                and phases[0] == "begin"
                and phases[-1] == "complete"
                and "verified" in phases
                and phases.index("verified") < len(phases) - 1
            ):
                plan = begin["plan"]
    finally:
        os.close(state_fd)
    if plan is None:
        stop("CANDIDATE_PRESERVED_STORAGE_UNATTESTED")
    directory_fd = os.open(app / name, _DIR_FLAGS)
    try:
        if _storage_plan_id(directory_fd) != plan:
            stop("CANDIDATE_PRESERVED_STORAGE_UNATTESTED")
    finally:
        os.close(directory_fd)
    tracked = run(
        "/usr/bin/git",
        "-c",
        "safe.directory=" + str(release),
        "-C",
        str(release),
        "ls-files",
        "--",
        "apps/platform/" + name,
        capture=True,
    )
    if tracked:
        stop("CANDIDATE_PRESERVED_STORAGE_UNATTESTED")
    return name


def verify_candidate(sha):
    release = RELEASES / ("platform-" + sha[:12])
    info = os.lstat(release)
    if not stat.S_ISDIR(info.st_mode) or (info.st_mode & 0o022):
        stop("CANDIDATE_UNSAFE")
    if not (release / ".git").is_dir():
        stop("CANDIDATE_GIT_MISSING")
    expected = run(
        "/usr/bin/git",
        "-c",
        "safe.directory=" + str(release),
        "-C",
        str(release),
        "rev-parse",
        "HEAD",
        capture=True,
    )
    if expected != sha:
        stop("CANDIDATE_SHA_MISMATCH")
    # Laravel tracks storage placeholder files, while the approved runtime
    # MUST replace apps/platform/storage with one persistent shared symlink.
    # Exclude ONLY this path from Git's cleanliness scan after independently
    # attesting it is the exact approved shared directory outside releases.
    # Every other tracked or untracked source path remains checked normally.
    if not (release / "apps/platform/storage").is_symlink():
        stop("CONTINUITY_STORAGE_NOT_SHARED")
    real_storage(release)
    preserved = preserved_storage_name(release)
    excludes = [":(exclude)apps/platform/storage"]
    if preserved:
        excludes.append(":(exclude)apps/platform/" + preserved)
    dirty = run(
        "/usr/bin/git",
        "-c",
        "safe.directory=" + str(release),
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        str(release),
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--",
        ".",
        *excludes,
        capture=True,
    )
    if dirty:
        stop("CANDIDATE_DIRTY")
    for item in (
        "apps/platform/artisan",
        "apps/platform/vendor/autoload.php",
        "apps/platform/public/build/manifest.json",
        "apps/platform/public/assets/kmj-codebridge-icon.png",
    ):
        file = release / item
        if not file.is_file() or file.stat().st_size <= 0:
            stop("CANDIDATE_ARTIFACT_MISSING")
    return release


ENV_MAX_BYTES = 65536
# The ONLY accepted storage location: persistent, outside every release tree, so pruning or rolling
# back a release directory can never delete customer uploads.
SHARED_STORAGE = ROOT / "shared" / "storage"
LOCK_OWNER_UID = 0
TRUST_ANCHOR = Path("/")


def trusted_uids():
    import pwd

    return {0, pwd.getpwnam(SERVICE_USER).pw_uid}


def chain_is_trusted(path):
    """Every component from / down to path: real directory, owned by root or the service user,
    not group/other writable. A symlink anywhere fails closed."""
    allowed = trusted_uids()
    try:
        tail = path.relative_to(TRUST_ANCHOR).parts
    except ValueError:
        return False
    parts = [TRUST_ANCHOR]
    for part in tail:
        parts.append(parts[-1] / part)
    for item in parts:
        try:
            info = os.lstat(item)
        except OSError:
            return False
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid not in allowed
            or (info.st_mode & 0o022)
        ):
            return False
    return True


def read_env_digest(release):
    """sha256 of the release .env: one no-follow descriptor, bounded streaming over ALL bytes, and
    identity/size/time stability checked before and after. Never returns or prints content."""
    path = release / "apps/platform/.env"
    try:
        path_info = os.lstat(path)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        stop("CONTINUITY_ENV_MISSING")
    try:
        before = os.fstat(fd)
        key = lambda i: (i.st_dev, i.st_ino, i.st_size, i.st_mtime_ns, i.st_ctime_ns, i.st_nlink)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size > ENV_MAX_BYTES
            or (path_info.st_dev, path_info.st_ino) != (before.st_dev, before.st_ino)
        ):
            stop("CONTINUITY_ENV_UNSAFE")
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(fd, 8192)
            if not chunk:
                break
            total += len(chunk)
            if total > ENV_MAX_BYTES:
                stop("CONTINUITY_ENV_UNSAFE")
            digest.update(chunk)
        after = os.fstat(fd)
        if total != before.st_size or key(before) != key(after):
            stop("CONTINUITY_ENV_UNSTABLE")
    finally:
        os.close(fd)
    return digest.hexdigest()


def real_storage(release):
    """Real directory behind <release>/apps/platform/storage. It must be exactly the approved shared
    location outside all release trees, with an integrity-checked ancestor chain."""
    real = Path(os.path.realpath(release / "apps/platform/storage"))
    if real != SHARED_STORAGE:
        stop("CONTINUITY_STORAGE_NOT_SHARED")
    if not chain_is_trusted(real):
        stop("CONTINUITY_STORAGE_UNTRUSTED")
    try:
        app = os.lstat(real / "app")
    except OSError:
        stop("CONTINUITY_STORAGE_MISSING")
    if not stat.S_ISDIR(app.st_mode):
        stop("CONTINUITY_STORAGE_MISSING")
    return real


def continuity_snapshot(release):
    return {"env": read_env_digest(release), "storage": real_storage(release)}


def verify_continuity(current_release, candidate):
    """Customer uploads and runtime configuration must survive the pointer switch.

    storage/app and .env live inside the release tree. A freshly built candidate has neither, so an
    unchecked switch passes the login/icon health check yet silently orphans every customer upload.
    Require BEFORE switching: a byte-identical .env and BOTH releases using the single approved shared
    storage directory outside the release trees. A copy cannot be race-free against live uploads and
    storage inside an old release is destroyed by pruning, so neither is accepted.
    Only fixed categories are raised; no path or content is reported.
    """
    before = continuity_snapshot(RELEASES / current_release)
    candidate_state = continuity_snapshot(candidate)
    if candidate_state["env"] != before["env"]:
        stop("CONTINUITY_ENV_DIFFERS")
    return before


def verify_continuity_after_switch(before, new_target, candidate):
    """Through the live pointer: CURRENT must be exactly the approved candidate, and env/storage must
    be unchanged. Any difference triggers the existing rollback."""
    try:
        pointer = os.readlink(CURRENT)
    except OSError:
        stop("CONTINUITY_POINTER_LOST")
    if pointer != new_target or Path(os.path.realpath(CURRENT)) != Path(os.path.realpath(candidate)):
        stop("CONTINUITY_POINTER_LOST")
    after = continuity_snapshot(CURRENT)
    if after != before:
        stop("CONTINUITY_LOST_AFTER_SWITCH")


def switch_to(target, tag):
    temporary = ROOT / (".current-" + tag + "-" + str(os.getpid()))
    try:
        os.symlink(target, temporary)
        os.replace(temporary, CURRENT)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def health_check():
    services_ok()
    run("/usr/sbin/nginx", "-t")
    for url in (ORIGIN + "/login", ORIGIN + "/assets/kmj-codebridge-icon.png"):
        run(
            "/usr/bin/curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "20",
            "--resolve",
            "kmjtechno.com:443:127.0.0.1",
            url,
        )


class locked_release_lock:
    """Fail-closed shared release lock: pin inode, metadata, and path after flock.

    No existing mode is repaired. A planted symlink/FIFO/hardlink/foreign inode,
    unsafe lock parent or a replacement between open and lock acquisition is
    rejected before production release/backup metadata is read.
    """

    def _attest(self):
        try:
            info = os.fstat(self.fd)
            path = os.lstat(LOCK)
        except OSError:
            stop("LOCK_UNSAFE")
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != LOCK_OWNER_UID
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
            or not stat.S_ISREG(path.st_mode)
            or (path.st_dev, path.st_ino) != (info.st_dev, info.st_ino)
            or path.st_uid != info.st_uid
            or path.st_nlink != 1
            or stat.S_IMODE(path.st_mode) != 0o600
        ):
            stop("LOCK_UNSAFE")

    def __enter__(self):
        try:
            parent = os.lstat(LOCK.parent)
            mode = stat.S_IMODE(parent.st_mode)
            if (
                not stat.S_ISDIR(parent.st_mode)
                or parent.st_uid != LOCK_OWNER_UID
                or ((mode & 0o022) and mode != 0o1777)
            ):
                stop("LOCK_UNSAFE")
        except OSError:
            stop("LOCK_UNSAFE")
        flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
        try:
            try:
                self.fd = os.open(LOCK, flags | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                self.fd = os.open(LOCK, flags)
        except OSError:
            stop("LOCK_UNSAFE")
        try:
            self._attest()
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                stop("LOCK_BUSY")
            self._attest()
            return self
        except BaseException:
            os.close(self.fd)
            raise

    def __exit__(self, *exc):
        os.close(self.fd)
        return False


def main():
    if os.geteuid() != 0:
        stop("ROOT_REQUIRED")
    if len(sys.argv) != 1:
        stop("NO_CALLER_ARGUMENTS_ALLOWED")
    LOCK.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    with locked_release_lock():
        approval = read_approved()
        sha = approval["approvedSha"]
        current, old_target = release_symlink()
        if current != approval["expectedCurrentRelease"]:
            stop("EXPECTED_CURRENT_RELEASE_MISMATCH")
        services_ok()
        run("/usr/sbin/nginx", "-t")
        verify_backup(sha, current)
        candidate = verify_candidate(sha)
        continuity = verify_continuity(current, candidate)
        new_target = "releases/" + candidate.name
        if old_target == new_target:
            stop("ALREADY_ACTIVE")
        print("MAIN_PLATFORM_ACTIVATION_START " + sha[:12], flush=True)
        changed = False
        try:
            switch_to(new_target, "approved")
            changed = True
            run("/usr/bin/systemctl", "reload", "php8.4-fpm.service")
            verify_continuity_after_switch(continuity, new_target, candidate)
            health_check()
            # Previous pointer is updated only after healthy activation.
            temporary = ROOT / (".previous-" + str(os.getpid()))
            try:
                os.symlink(old_target, temporary)
                os.replace(temporary, PREVIOUS)
            finally:
                if temporary.is_symlink():
                    temporary.unlink()
        except Exception:
            if changed:
                switch_to(old_target, "rollback")
                run("/usr/bin/systemctl", "reload", "php8.4-fpm.service")
                health_check()
                print("MAIN_PLATFORM_ROLLBACK_VERIFIED", flush=True)
            raise
        print("MAIN_PLATFORM_ACTIVATION_PASS " + sha, flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Emit only fixed categories; never echo config, filesystem or tokens.
        code = str(exc)
        if not re.fullmatch(r"[A-Z_]{3,90}", code):
            code = "RELEASE_ACTIVATION_FAILED"
        print("MAIN_PLATFORM_ACTIVATION_FAIL " + code, file=sys.stderr)
        sys.exit(1)
