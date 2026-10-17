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
    with tarfile.open(archive, "r:gz") as tf:
        count = 0
        for member in tf:
            n = member.name.removeprefix("./")
            parts = Path(n).parts
            if not parts or parts[0] != NAME or ".." in parts or n.startswith("/"):
                raise RuntimeError("ARCHIVE_UNSAFE_ENTRY")
            if member.isdev() or member.isfifo():
                raise RuntimeError("ARCHIVE_UNSAFE_SPECIAL_FILE")
            count += 1
        if count < 5:
            raise RuntimeError("ARCHIVE_INCOMPLETE")
    digest = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()
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
            # The archive was generated and vetted by this process, not untrusted input.
            with tarfile.open(archive, "r:gz") as tf:
                tf.extractall(ROOT, filter="data")
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
        dest = BACKUP_BASE / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        dest.mkdir(parents=True, mode=0o700, exist_ok=False)
        old_free = avail()
        stopped = False
        removed = False
        archive = None
        try:
            # Controlled canary: if production health changes while kvm01 is
            # stopped, reverse the stop before touching its stored image.
            run(["systemctl", "stop", UNIT], timeout=90)
            stopped = True
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

if __name__ == "__main__":
    try:
        sys.exit(main())
    except BaseException as e:
        if isinstance(e, KeyboardInterrupt):
            print("RETIREMENT_INTERRUPTED", file=sys.stderr)
            sys.exit(130)
        print("RETIREMENT_ERROR=" + type(e).__name__ +
              (":" + str(e) if isinstance(e, RuntimeError) else ""),
              file=sys.stderr)
        sys.exit(2)
