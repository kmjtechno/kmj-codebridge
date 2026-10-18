#!/usr/bin/env python3
"""Retire ONE obsolete nspawn KVM-simulation guest on the approved Google CloudOS host.
Default is audit. Apply stops the guest, proves host health, archives and verifies
its rootfs, then asks machinectl to remove only that image. Local archive kept.
This is not offsite backup, production KVM qualification or fleet release credit.
"""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone
from urllib.request import Request, build_opener, ProxyHandler

HOST = "google-vps1"
GCE_NAME = "instance-20260912-094732"
# kvm01 is independently retired. Only these two simulation guests are eligible.
ALLOWED_GUESTS = ("kvm02", "kvm03")
NAME = None
ROOT = Path("/var/lib/machines")
IMAGE = None
UNIT = None
BACKUP_BASE = Path("/var/backups/kmj-cloudos-guest-retirement")
# Fleet-wide lock serializes kvm02 and kvm03 even under separate invocations.
LOCK = Path("/run/lock/kmj-cloudos-simfleet-retirement.lock")
SERVICES = ("kmj-cloudos-api.service", "kmj-cloudos-worker.service",
            "kmj-codebridge-cloudos.service")
MIN_FREE_BEFORE = 8 * 1024 ** 3
MIN_FREE_AFTER_BACKUP = 4 * 1024 ** 3

# Reuse-only option is deliberately pinned to one completed guest archive.
# This local backup may not contain writes made after its snapshot; kvm02 is
# specifically qualified as an obsolete synthetic test container.
REUSE_KVM02_SUBDIR = "20261017T150330Z-kvm02"
REUSE_KVM02_DIGEST = "51e3a3687c83b14b1d635c3f3a90443cc773a3c9bc6277ee724aeced03903482"

# Observed by operator: 2026-10-18 complete staged guest archive. Not atomic.
REUSE_KVM03_SUBDIR = "20261018T080147Z-kvm03"
REUSE_KVM03_DIGEST = "cad6a717bc31c2e927d6daef68f1ffa19eebb79d62d78ac2f54cd7749c6f1a1b"


def run(argv, timeout=30, ok=(0,)):
    p = subprocess.run(argv, check=False, stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, text=True, timeout=timeout,
                       env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"})
    if p.returncode not in ok:
        raise RuntimeError("COMMAND_FAILED:" + argv[0] + ":" + argv[1])
    return p.stdout.strip()

def avail():
    return shutil.disk_usage("/").free

def local_get(url, headers=None):
    req = Request(url, headers=headers or {})
    opener = build_opener(ProxyHandler({}))
    with opener.open(req, timeout=5) as resp:
        if resp.status != 200:
            raise RuntimeError("HTTP_NOT_200")
        return resp.read(256).decode("utf-8", "replace").strip()

def machine_state():
    rows = run(["machinectl", "list", "--no-pager", "--no-legend"], timeout=15)
    for row in rows.splitlines():
        columns = row.split()
        if len(columns) >= 3 and columns[0] == NAME:
            if columns[1] != "container" or columns[2] != "systemd-nspawn":
                raise RuntimeError("GUEST_TYPE_NOT_NSPAWN")
            return "running"
    return "absent"

def image_exists():
    st = IMAGE.lstat()
    if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_uid != 0:
        raise RuntimeError("IMAGE_ROOT_UNSAFE")
    images = run(["machinectl", "list-images", "--no-legend", "--no-pager"])
    if NAME not in [line.split()[0] for line in images.splitlines() if line.split()]:
        raise RuntimeError("IMAGE_NOT_REGISTERED")
    return True

def healthy():
    for service in SERVICES:
        if run(["systemctl", "is-active", service], timeout=10) != "active":
            raise RuntimeError("CRITICAL_SERVICE_NOT_ACTIVE:" + service)
    if local_get("http://127.0.0.1:8080/dashboard") == "":
        raise RuntimeError("EMPTY_DASHBOARD")
    print("CLOUDOS_API_WORKER_AGENT_DASHBOARD=PASS", flush=True)

def dependency_guard():
    # Do not retire a guest if the production services directly name it in
    # installed systemd configuration/known unit relationships.
    for service in SERVICES:
        for args in (
            ["systemctl", "cat", service],
            ["systemctl", "show", service, "-pRequires", "-pWants",
             "-pBindsTo", "-pPartOf", "-pAfter", "-pEnvironment"],
        ):
            if re.search(r"\b" + re.escape(NAME) + r"\b",
                         run(args, timeout=15), flags=re.I):
                raise RuntimeError("LIVE_SERVICE_REFERENCES_GUEST")
    mounts = run(["findmnt", "--raw", "--noheadings", "--output", "TARGET"])
    target = str(IMAGE)
    if any(m == target or m.startswith(target + "/") for m in mounts.splitlines()):
        raise RuntimeError("NESTED_GUEST_MOUNT_PRESENT")
    jobs = run(["systemctl", "list-jobs", "--no-legend", "--no-pager"], timeout=15)
    if NAME in jobs:
        raise RuntimeError("GUEST_SYSTEMD_JOB_ACTIVE")

def identity():
    if os.geteuid() != 0 or os.uname().nodename != HOST:
        raise RuntimeError("WRONG_HOST_OR_NOT_ROOT")
    metadata = local_get(
        "http://metadata.google.internal/computeMetadata/v1/instance/name",
        {"Metadata-Flavor": "Google"},
    )
    if metadata != GCE_NAME:
        raise RuntimeError("WRONG_GCE_INSTANCE")
    # These look like KVM hypervisors by name, but the actual host cannot
    # qualify them as KVM nodes. Never mistake their loss for release credit.
    if Path("/dev/kvm").exists():
        raise RuntimeError("KVM_DEVICE_PRESENT_REVIEW_ROLE")
    if ROOT.is_symlink() or not ROOT.is_dir():
        raise RuntimeError("MACHINES_ROOT_UNSAFE")
    image_exists()
    if machine_state() != "running":
        raise RuntimeError("CANARY_NOT_RUNNING_REVIEW_REQUIRED")
    if run(["systemctl", "is-active", UNIT]) != "active":
        raise RuntimeError("NSPAWN_UNIT_NOT_ACTIVE")
    dependency_guard()
    healthy()

def validate_archive(archive):
    """Validate a complete rootfs archive, including ordinary /dev device nodes.

    Linux systemd-nspawn roots naturally contain character/block device entries.
    A blanket rejection makes genuine archives unusable. Retain that metadata
    only under the one guest's /dev; fail closed on path traversal, unknown
    types, hard links outside this guest, or device files elsewhere.
    """
    members = 0
    devices = 0
    fifos = 0
    symlink_names = set()
    seen = set()
    with tarfile.open(archive, "r:gz") as tf:
        for member in tf:
            name = member.name.removeprefix("./").rstrip("/")
            parts = Path(name).parts
            if (not parts or parts[0] != NAME or ".." in parts
                    or name.startswith("/") or chr(0) in name):
                raise RuntimeError("ARCHIVE_UNSAFE_ENTRY")
            if name in seen:
                raise RuntimeError("ARCHIVE_DUPLICATE_MEMBER")
            seen.add(name)
            if not (member.isfile() or member.isdir() or member.issym()
                    or member.islnk() or member.ischr() or member.isblk()
                    or member.isfifo()):
                raise RuntimeError("ARCHIVE_UNKNOWN_ENTRY_TYPE")
            if member.islnk():
                link = member.linkname
                link_parts = Path(link).parts
                if (not link_parts or link_parts[0] != NAME
                        or ".." in link_parts or link.startswith("/")):
                    raise RuntimeError("ARCHIVE_UNSAFE_HARDLINK")
            if member.issym():
                symlink_names.add(name)
            if member.ischr() or member.isblk():
                if (len(parts) < 3 or parts[1] != "dev"
                        or not isinstance(member.devmajor, int)
                        or not isinstance(member.devminor, int)
                        or not 0 <= member.devmajor <= 4095
                        or not 0 <= member.devminor <= 1048575):
                    raise RuntimeError("ARCHIVE_UNSAFE_DEVICE_LOCATION")
                devices += 1
            if member.isfifo():
                fifos += 1
            # tar_filter protects member extraction paths; unlike data_filter
            # it retains the original rootfs ownership and device nodes.
            try:
                tarfile.tar_filter(member, str(ROOT / f".kmj-{NAME}-preview-only"))
            except tarfile.FilterError as exc:
                raise RuntimeError("ARCHIVE_UNSAFE_LINK_OR_PATH") from exc
            members += 1
        if members < 5:
            raise RuntimeError("ARCHIVE_INCOMPLETE")
    # An archive containing a symlink directory followed by descendants is
    # unsafe to unpack as root, even with a trusted archive origin.
    for name in seen:
        parts = Path(name).parts
        for depth in range(1, len(parts)):
            if "/".join(parts[:depth]) in symlink_names:
                raise RuntimeError("ARCHIVE_SYMLINK_PARENT")
    print("ARCHIVE_DEVICE_NODES_VALIDATED=" + str(devices), flush=True)
    print("ARCHIVE_FIFOS_VALIDATED=" + str(fifos), flush=True)
    print("ARCHIVE_MEMBERS_VALIDATED=" + str(members), flush=True)
    return members


def classify_tar_failure(diag):
    """Emit bounded categorical evidence, never tar's raw private file paths."""
    try:
        errors = diag.read_text(encoding="utf-8", errors="replace")[:65536].lower()
    except OSError:
        return "DIAGNOSTIC_UNREADABLE"
    rules = (
        ("NO_SPACE", ("no space left on device", "disk quota exceeded")),
        ("IO_ERROR", ("input/output error", "read error", "write error")),
        ("PERMISSION", ("permission denied", "operation not permitted")),
        ("SOURCE_CHANGED", ("file changed as we read it", "file shrank by")),
        ("SOURCE_VANISHED", ("file removed before we read it", "cannot stat")),
        ("XATTR_OR_ACL", ("cannot set acl", "cannot read acl", "xattr", "extended attributes")),
        ("BROKEN_PIPE", ("broken pipe",)),
    )
    for code, signatures in rules:
        if any(item in errors for item in signatures):
            return code
    return "OTHER_REVIEW_REQUIRED" if errors.strip() else "NO_STDERR_AVAILABLE"


def backup_guest(dest, source_root=ROOT):
    # Failure evidence goes into a root-only log. Never leave a failed tar
    # stream taking another 1-4 GB on an already constrained Google VM.
    archive = dest / f"{NAME}.tar.gz"
    partial = dest / f".{NAME}.tar.gz.unverified-partial"
    diag = dest / "tar-diagnostic.log"
    try:
        with partial.open("xb") as output, diag.open("xb") as errors:
            os.fchmod(errors.fileno(), 0o600)
            proc = subprocess.run(
                ["tar", "--numeric-owner", "--xattrs", "--acls",
                 "--one-file-system", "-czf", "-", "-C", str(source_root), NAME],
                stdout=output, stderr=errors, timeout=900,
                check=False,
            )
        if proc.returncode != 0:
            print("ARCHIVE_CREATE_EXIT_CODE=" + str(proc.returncode), flush=True)
            print("ARCHIVE_CREATE_ERROR_CLASS=" + classify_tar_failure(diag), flush=True)
            print("TAR_DIAGNOSTIC_LOG=" + str(diag), flush=True)
            raise RuntimeError("ARCHIVE_CREATE_FAILED")
        if avail() < MIN_FREE_AFTER_BACKUP:
            raise RuntimeError("DISK_LOW_AFTER_BACKUP")
        validate_archive(partial)
        with partial.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        os.replace(partial, archive)
        (dest / "SHA256SUMS").write_text(digest + f"  {NAME}.tar.gz\n")
        print("LOCAL_BACKUP_VALIDATED=YES", flush=True)
        print("ARCHIVE_BYTES=" + str(archive.stat().st_size), flush=True)
        print("ARCHIVE_SHA256=" + digest, flush=True)
        return archive
    except BaseException:
        # This attempt's staging bytes have NEVER been independently
        # validated. Preserve old archives and every verified SHA256SUMS.
        if partial.is_file() and not partial.is_symlink():
            partial.unlink()
            print("THIS_ATTEMPT_UNVERIFIED_PARTIAL_REMOVED=YES", flush=True)
        raise

def staged_backup_guest(dest):
    """Full guest copy first, then tar a stable private tree.

    Used ONLY for kvm03's host-journald metadata race. No journal paths
    excluded or tar warnings ignored. The copy is best-effort, not an atomic
    filesystem snapshot; source guest must already be stopped.
    """
    if NAME != "kvm03":
        raise RuntimeError("STAGED_COPY_ONLY_AUTHORIZED_FOR_KVM03")
    src_bytes = int(run(["du", "-sx", "-B1", str(IMAGE)],
                        timeout=180).split()[0])
    if src_bytes < 1 or avail() < src_bytes + MIN_FREE_AFTER_BACKUP + 536870912:
        raise RuntimeError("INSUFFICIENT_STAGING_HEADROOM")
    stage = dest / ".kvm03-staging-root"
    if stage.exists() or stage.is_symlink():
        raise RuntimeError("STAGING_DIRECTORY_ALREADY_EXISTS")
    stage.mkdir(mode=0o700)
    try:
        log = dest / "copy-diagnostic.log"
        with log.open("xb") as errors:
            os.fchmod(errors.fileno(), 0o600)
            proc = subprocess.run(
                ["cp", "-a", "-x", "--reflink=auto", "--",
                 str(IMAGE), str(stage / NAME)],
                stdout=subprocess.DEVNULL, stderr=errors,
                check=False, timeout=1200,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
            )
        if proc.returncode != 0:
            print("STAGING_COPY_EXIT_CODE=" + str(proc.returncode), flush=True)
            print("STAGING_COPY_DIAGNOSTIC_LOG=" + str(log), flush=True)
            raise RuntimeError("STAGING_COPY_FAILED")
        copied = stage / NAME
        meta = copied.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0:
            raise RuntimeError("STAGED_ROOT_UNSAFE")
        staged_bytes = int(run(["du", "-sx", "-B1", str(copied)],
                               timeout=180).split()[0])
        # Worst case uncompressed archive is near full source size. Stop
        # before tar if the archive could reduce root free below 4 GiB.
        if avail() < staged_bytes + MIN_FREE_AFTER_BACKUP + 268435456:
            raise RuntimeError("INSUFFICIENT_ARCHIVE_HEADROOM_AFTER_STAGE")
        print("STAGED_FULL_GUEST_COPY=PASS", flush=True)
        print("STAGING_BYTES=" + str(staged_bytes), flush=True)
        print("STAGING_JOURNAL_OMITTED=NO", flush=True)
        print("STAGING_COPY_ATOMIC_SNAPSHOT=NO", flush=True)
        return backup_guest(dest, source_root=stage)
    finally:
        # Private one-off source snapshot: never leave 4-8 GiB of staging
        # data on a limited-space VPS after success or failure.
        shutil.rmtree(stage)
        print("STAGING_COPY_CLEANUP=PASS", flush=True)


def existing_verified_kvm02_backup():
    if NAME != "kvm02":
        raise RuntimeError("REUSE_ONLY_AUTHORIZED_FOR_KVM02")
    dest = BACKUP_BASE / REUSE_KVM02_SUBDIR
    archive = dest / "kvm02.tar.gz"
    manifest = dest / "SHA256SUMS"
    for item in (dest, archive, manifest):
        if item.is_symlink():
            raise RuntimeError("EXISTING_BACKUP_SYMLINK_UNSAFE")
        meta = item.stat()
        if meta.st_uid != 0:
            raise RuntimeError("EXISTING_BACKUP_OWNER_UNSAFE")
        # Archive and checksum can be 0644 because the validated parent
        # directory and the backup pool are both root-only 0700.
        forbidden = 0o077 if item == dest else 0o022
        if meta.st_mode & forbidden:
            raise RuntimeError("EXISTING_BACKUP_PERMISSIONS_UNSAFE")
    if not dest.is_dir() or not archive.is_file() or not manifest.is_file():
        raise RuntimeError("EXISTING_BACKUP_TYPE_UNSAFE")
    expected = REUSE_KVM02_DIGEST + "  kvm02.tar.gz\n"
    if manifest.read_text(encoding="ascii") != expected:
        raise RuntimeError("EXISTING_BACKUP_MANIFEST_MISMATCH")
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != REUSE_KVM02_DIGEST:
        raise RuntimeError("EXISTING_BACKUP_CHECKSUM_MISMATCH")
    validate_archive(archive)
    print("EXISTING_KVM02_BACKUP_SHA256=PASS", flush=True)
    print("EXISTING_KVM02_BACKUP_PATH=" + str(dest), flush=True)
    return archive


def existing_verified_kvm03_backup():
    if NAME != "kvm03":
        raise RuntimeError("REUSE_ONLY_AUTHORIZED_FOR_KVM03")
    dest = BACKUP_BASE / REUSE_KVM03_SUBDIR
    archive = dest / "kvm03.tar.gz"
    manifest = dest / "SHA256SUMS"
    for item in (dest, archive, manifest):
        if item.is_symlink():
            raise RuntimeError("EXISTING_BACKUP_SYMLINK_UNSAFE")
        meta = item.stat()
        if meta.st_uid != 0:
            raise RuntimeError("EXISTING_BACKUP_OWNER_UNSAFE")
        # Archive and checksum can be 0644 because the validated parent
        # directory and the backup pool are both root-only 0700.
        forbidden = 0o077 if item == dest else 0o022
        if meta.st_mode & forbidden:
            raise RuntimeError("EXISTING_BACKUP_PERMISSIONS_UNSAFE")
    if not dest.is_dir() or not archive.is_file() or not manifest.is_file():
        raise RuntimeError("EXISTING_BACKUP_TYPE_UNSAFE")
    expected = REUSE_KVM03_DIGEST + "  kvm03.tar.gz\n"
    if manifest.read_text(encoding="ascii") != expected:
        raise RuntimeError("EXISTING_BACKUP_MANIFEST_MISMATCH")
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != REUSE_KVM03_DIGEST:
        raise RuntimeError("EXISTING_BACKUP_CHECKSUM_MISMATCH")
    validate_archive(archive)
    print("EXISTING_KVM03_BACKUP_SHA256=PASS", flush=True)
    print("EXISTING_KVM03_BACKUP_PATH=" + str(dest), flush=True)
    return archive


def remove_with_diagnostics(diag):
    """Capture machinectl's real stderr, classify it without leaking paths."""
    with diag.open("xb") as output:
        os.fchmod(output.fileno(), 0o600)
        try:
            proc = subprocess.run(
                ["machinectl", "remove", NAME],
                stdout=output, stderr=subprocess.STDOUT, timeout=120,
                check=False,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
            )
        except subprocess.TimeoutExpired:
            print("MACHINECTL_REMOVE_ERROR_CLASS=TIMEOUT", flush=True)
            raise RuntimeError("MACHINECTL_REMOVE_TIMEOUT")
    if proc.returncode:
        try:
            message = diag.read_text(errors="replace")[:8192].lower()
        except OSError:
            message = ""
        codes = (
            ("BUSY", ("device or resource busy", "resource busy")),
            ("ACCESS_DENIED", ("access denied", "permission denied")),
            ("NOT_SUPPORTED", ("operation not supported", "not supported")),
            ("READ_ONLY", ("read-only file system",)),
            ("NO_SPACE", ("no space left on device",)),
            ("FILE_NOT_FOUND", ("no such file", "not found")),
            ("NOT_EMPTY", ("directory not empty",)),
            ("IO_ERROR", ("input/output error",)),
            ("INVALID_IMAGE", ("invalid image",)),
        )
        category = next(
            (label for label, phrases in codes
             if any(phrase in message for phrase in phrases)),
            "OTHER_REVIEW_REQUIRED",
        )
        print("MACHINECTL_REMOVE_EXIT_CODE=" + str(proc.returncode), flush=True)
        print("MACHINECTL_REMOVE_ERROR_CLASS=" + category, flush=True)
        print("MACHINECTL_DIAGNOSTIC_LOG=" + str(diag), flush=True)
        raise RuntimeError("MACHINECTL_REMOVE_FAILED")
    print("MACHINECTL_REMOVE=PASS", flush=True)


def revive(previous_enabled, archive, removed):
    try:
        if removed and not IMAGE.exists():
            if archive is None or not archive.is_file():
                raise RuntimeError("RESTORE_ARCHIVE_UNAVAILABLE")
            # Restore into a new private staging root and rename only after
            # extraction succeeds. A partial restore must never masquerade as a
            # bootable guest, and no archive entry may touch sibling guests.
            validate_archive(archive)
            with tempfile.TemporaryDirectory(prefix=f".kmj-{NAME}-restore-",
                                             dir=ROOT) as staging:
                with tarfile.open(archive, "r:gz") as tf:
                    tf.extractall(staging, filter="tar")
                restored = Path(staging) / NAME
                if (not restored.is_dir() or restored.is_symlink()
                        or IMAGE.exists()):
                    raise RuntimeError("RESTORED_ROOT_UNSAFE")
                os.replace(restored, IMAGE)
        if previous_enabled == "enabled":
            run(["systemctl", "enable", UNIT], timeout=30)
        run(["systemctl", "start", UNIT], timeout=60)
        for _ in range(30):
            if machine_state() == "running":
                print("CANARY_ROLLBACK=GUEST_RUNNING")
                return
            time.sleep(1)
        raise RuntimeError("GUEST_RESTART_TIMEOUT")
    except Exception as exc:
        print("CANARY_ROLLBACK=FAILED_" + type(exc).__name__, file=sys.stderr)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--guest", choices=ALLOWED_GUESTS, required=True)
    parser.add_argument("--apply", action="store_true",
                        help="retire ONLY the explicitly selected simulation guest")
    parser.add_argument("--reuse-verified-kvm02", action="store_true",
                        help="reuse the pinned, SHA-verified kvm02 test backup; never archive again")
    parser.add_argument("--staged-backup-kvm03", action="store_true",
                        help="preserve kvm03 journal with a private stopped-guest filesystem copy")
    parser.add_argument("--reuse-verified-kvm03", action="store_true",
                        help="reuse pinned SHA-verified kvm03 archive; no new stage or backup")
    args = parser.parse_args()
    global NAME, IMAGE, UNIT
    NAME = args.guest
    IMAGE = ROOT / NAME
    UNIT = f"systemd-nspawn@{NAME}.service"
    print(f"TARGET={NAME} TYPE=systemd-nspawn TEST_SIMULATOR")
    print("LXD_UPGRADE_NODES=UNTOUCHED OTHER_NSPAWN=UNTOUCHED")
    lockfd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_CLOEXEC |
                     getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(lockfd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        identity()
        print("GUEST_RETIREMENT_PREFLIGHT=PASS")
        print("ROOT_FREE_BEFORE_BYTES=" + str(avail()))
        print("MODE=" + ("CANARY_RETIRE" if args.apply else "READ_ONLY"))
        if not args.apply:
            return 0
        if avail() < MIN_FREE_BEFORE:
            raise RuntimeError("INSUFFICIENT_BACKUP_HEADROOM")
        if args.reuse_verified_kvm02 and NAME != "kvm02":
            raise RuntimeError("REUSE_ONLY_AUTHORIZED_FOR_KVM02")
        if args.staged_backup_kvm03 and NAME != "kvm03":
            raise RuntimeError("STAGING_ONLY_AUTHORIZED_FOR_KVM03")
        if sum((args.staged_backup_kvm03, args.reuse_verified_kvm02,
                args.reuse_verified_kvm03)) > 1:
            raise RuntimeError("CONFLICTING_BACKUP_STRATEGIES")
        if args.reuse_verified_kvm03 and NAME != "kvm03":
            raise RuntimeError("REUSE_ONLY_AUTHORIZED_FOR_KVM03")
        enabled = run(["systemctl", "is-enabled", UNIT], ok=(0, 1))
        if enabled not in ("enabled", "disabled"):
            raise RuntimeError("UNIT_ENABLEMENT_UNKNOWN")
        # Backups contain the guest's complete private filesystem. Never
        # follow an operator-unexpected symlink or permit world-readable files.
        if BACKUP_BASE.is_symlink():
            raise RuntimeError("BACKUP_BASE_SYMLINK_UNSAFE")
        BACKUP_BASE.mkdir(parents=True, mode=0o700, exist_ok=True)
        meta = BACKUP_BASE.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o077:
            raise RuntimeError("BACKUP_BASE_PERMISSIONS_UNSAFE")
        if args.reuse_verified_kvm02 or args.reuse_verified_kvm03:
            # Verify full tar and pinned SHA before touching any guest service.
            archive = (existing_verified_kvm02_backup()
                       if args.reuse_verified_kvm02
                       else existing_verified_kvm03_backup())
            dest = BACKUP_BASE / (REUSE_KVM02_SUBDIR if args.reuse_verified_kvm02
                                  else REUSE_KVM03_SUBDIR)
        else:
            dest = BACKUP_BASE / (
                datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + NAME)
            dest.mkdir(mode=0o700, exist_ok=False)
            archive = None
        old_free = avail()
        stopped = False
        removed = False
        try:
            # Controlled canary: if production health changes while this guest is
            # stopped, reverse the stop before touching its stored image.
            # A timed-out stop can still have stopped the unit. Always attempt
            # rollback after the first stop instruction, even on a timeout.
            stopped = True
            run(["systemctl", "stop", UNIT], timeout=90)
            for _ in range(30):
                if machine_state() == "absent":
                    break
                time.sleep(1)
            if machine_state() != "absent":
                raise RuntimeError("STOP_TIMEOUT")
            healthy()
            if not (args.reuse_verified_kvm02 or args.reuse_verified_kvm03):
                archive = (staged_backup_guest(dest)
                           if args.staged_backup_kvm03 else backup_guest(dest))
            dependency_guard()
            healthy()
            if enabled == "enabled":
                run(["systemctl", "disable", UNIT], timeout=30)
            if args.reuse_verified_kvm02 or args.reuse_verified_kvm03:
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
                remove_with_diagnostics(
                    dest / ("machinectl-removal-diagnostic-" + stamp + ".log")
                )
            else:
                run(["machinectl", "remove", NAME], timeout=120)
            removed = True
            if IMAGE.exists():
                raise RuntimeError("IMAGE_NOT_REMOVED")
            healthy()
            print("CANARY_RETIREMENT=PASS")
            print("BACKUP_LOCATION=" + str(dest))
            print("DISK_FREE_AFTER_BYTES=" + str(avail()))
            print("NET_SPACE_GAIN_BYTES=" + str(avail() - old_free))
            print("OTHER_GUEST_REMOVALS=NOT_AUTHORIZED")
            return 0
        except BaseException:
            if stopped:
                revive(enabled, archive, removed or not IMAGE.exists())
            print("CANARY_RETIREMENT=BLOCKED_OR_ROLLED_BACK", file=sys.stderr)
            raise

def main_entry() -> int:
    """Map expected completion to exit 0; never catch SystemExit(0) as failure."""
    try:
        return main()
    except KeyboardInterrupt:
        print("RETIREMENT_INTERRUPTED", file=sys.stderr)
        return 130
    except Exception as e:
        print("RETIREMENT_ERROR=" + type(e).__name__ +
              (":" + str(e) if isinstance(e, RuntimeError) else ""),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main_entry())
