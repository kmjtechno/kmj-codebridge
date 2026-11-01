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


def read_env_digest(release):
    """sha256 of the release .env, read through one no-follow descriptor. Never returns or prints content."""
    path = release / "apps/platform/.env"
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        stop("CONTINUITY_ENV_MISSING")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > ENV_MAX_BYTES:
            stop("CONTINUITY_ENV_UNSAFE")
        data = os.read(fd, ENV_MAX_BYTES + 1)
    finally:
        os.close(fd)
    if len(data) > ENV_MAX_BYTES:
        stop("CONTINUITY_ENV_UNSAFE")
    return hashlib.sha256(data).hexdigest()


def real_storage(release):
    """Real directory behind <release>/apps/platform/storage (resolves a shared-storage symlink)."""
    real = Path(os.path.realpath(release / "apps/platform/storage"))
    try:
        info = os.lstat(real)
        app = os.lstat(real / "app")
    except OSError:
        stop("CONTINUITY_STORAGE_MISSING")
    if not stat.S_ISDIR(info.st_mode) or not stat.S_ISDIR(app.st_mode):
        stop("CONTINUITY_STORAGE_MISSING")
    return real


def continuity_snapshot(release):
    return {"env": read_env_digest(release), "storage": real_storage(release)}


def verify_continuity(current_release, candidate):
    """Customer uploads and runtime configuration must survive the pointer switch.

    storage/app and .env live inside the release tree. A freshly built candidate has neither, so an
    unchecked switch passes the login/icon health check yet silently orphans every customer upload.
    Require BEFORE switching: byte-identical .env and the very same real storage directory (a shared
    storage link). A copy cannot be race-free against live uploads, so a copy is not accepted.
    Only fixed categories are raised; no path or content is reported.
    """
    before = continuity_snapshot(RELEASES / current_release)
    candidate_state = continuity_snapshot(candidate)
    if candidate_state["env"] != before["env"]:
        stop("CONTINUITY_ENV_DIFFERS")
    if candidate_state["storage"] != before["storage"]:
        stop("CONTINUITY_STORAGE_NOT_SHARED")
    return before


def verify_continuity_after_switch(before):
    """Read the same facts through the live pointer; any difference triggers the existing rollback."""
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


def main():
    if os.geteuid() != 0:
        stop("ROOT_REQUIRED")
    if len(sys.argv) != 1:
        stop("NO_CALLER_ARGUMENTS_ALLOWED")
    LOCK.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    with LOCK.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
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
            verify_continuity_after_switch(continuity)
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
