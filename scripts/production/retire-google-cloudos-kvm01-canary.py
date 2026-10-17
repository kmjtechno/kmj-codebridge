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
NAME = "kvm01"  # Only first canary. Further guests require separate review.
ROOT = Path("/var/lib/machines")
IMAGE = ROOT / NAME
UNIT = f"systemd-nspawn@{NAME}.service"
BACKUP_BASE = Path("/var/backups/kmj-cloudos-guest-retirement")
LOCK = Path("/run/lock/kmj-cloudos-kvm01-retirement.lock")
SERVICES = ("kmj-cloudos-api.service", "kmj-cloudos-worker.service",
            "kmj-codebridge-cloudos.service")
MIN_FREE_BEFORE = 8 * 1024 ** 3
MIN_FREE_AFTER_BACKUP = 4 * 1024 ** 3

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
            if re.search(r"\bkvm01\b", run(args, timeout=15), flags=re.I):
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
                    or name.startswith("/") or "\\x00" in name):
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
                tarfile.tar_filter(member, str(ROOT / ".kmj-kvm01-preview-only"))
            except tarfile.FilterError as exc:
                raise RuntimeError("ARCHIVE_UNSAFE_LINK_OR_PATH") from exc
            members += 1
        if members < 5:
            raise RuntimeError("ARCHIVE_INCOMPLETE")
    # An archive containing a symlink directory followed by descendants is
    # unsafe to unpack as root, even with a trusted archive origin.
    for name in seen:
        if any(name.startswith(link + "/") for link in symlink_names):
            raise RuntimeError("ARCHIVE_SYMLINK_PARENT")
    print("ARCHIVE_DEVICE_NODES_VALIDATED=" + str(devices), flush=True)
    print("ARCHIVE_FIFOS_VALIDATED=" + str(fifos), flush=True)
    print("ARCHIVE_MEMBERS_VALIDATED=" + str(members), flush=True)
    return members


def backup_guest(dest):
    archive = dest / "kvm01.tar.gz"
    with archive.open("xb") as output:
        proc = subprocess.run(
            ["tar", "--numeric-owner", "--xattrs", "--acls",
             "--one-file-system", "-czf", "-", "-C", str(ROOT), NAME],
            stdout=output, stderr=subprocess.DEVNULL, timeout=900,
            check=False,
        )
    if proc.returncode != 0:
        raise RuntimeError("ARCHIVE_CREATE_FAILED")
    if avail() < MIN_FREE_AFTER_BACKUP:
        raise RuntimeError("DISK_LOW_AFTER_BACKUP")
    validate_archive(archive)
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    (dest / "SHA256SUMS").write_text(digest + "  kvm01.tar.gz\n")
    print("LOCAL_BACKUP_VALIDATED=YES", flush=True)
    print("ARCHIVE_BYTES=" + str(archive.stat().st_size), flush=True)
    print("ARCHIVE_SHA256=" + digest, flush=True)
    return archive

def revive(previous_enabled, archive, removed):
    try:
        if removed and not IMAGE.exists():
            if archive is None or not archive.is_file():
                raise RuntimeError("RESTORE_ARCHIVE_UNAVAILABLE")
            # Restore into a new private staging root and rename only after
            # extraction succeeds. A partial restore must never masquerade as a
            # bootable kvm01, and no archive entry may touch sibling guests.
            validate_archive(archive)
            with tempfile.TemporaryDirectory(prefix=".kmj-kvm01-restore-",
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
    parser.add_argument("--apply", action="store_true",
                        help="retire only kvm01 after a verified local archive")
    args = parser.parse_args()
    print("TARGET=kvm01 TYPE=systemd-nspawn TEST_SIMULATOR")
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
        dest = BACKUP_BASE / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        dest.mkdir(mode=0o700, exist_ok=False)
        old_free = avail()
        stopped = False
        removed = False
        archive = None
        try:
            # Controlled canary: if production health changes while kvm01 is
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
            archive = backup_guest(dest)
            dependency_guard()
            healthy()
            if enabled == "enabled":
                run(["systemctl", "disable", UNIT], timeout=30)
            run(["machinectl", "remove", NAME], timeout=120)
            removed = True
            if IMAGE.exists():
                raise RuntimeError("IMAGE_NOT_REMOVED")
            healthy()
            print("CANARY_RETIREMENT=PASS")
            print("BACKUP_LOCATION=" + str(dest))
            print("DISK_FREE_AFTER_BYTES=" + str(avail()))
            print("NET_SPACE_GAIN_BYTES=" + str(avail() - old_free))
            print("FURTHER_GUEST_REMOVALS=REQUIRE_SEPARATE_QUALIFICATION")
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
