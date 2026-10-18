#!/usr/bin/env python3
"""Guarded Google CloudOS VPS cleanup: EXACT disabled Snap revisions only.

Default audit never mutates anything. --apply is operator-executed on the
pinned GCE host; no arbitrary packages, VM, project, backup or shell access.
A removed old Snap revision can no longer be selected for local rollback.
"""
import argparse
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.request import Request, build_opener, ProxyHandler

HOST = "google-vps1"
GCE_NAME = "instance-20260912-094732"
TARGETS = (
    ("canonical-livepatch", "414"),
    ("core24", "1643"),
    ("core26", "462"),
    ("google-cloud-cli", "509"),
    ("snapd", "27738"),
)
SERVICES = (
    "kmj-cloudos-api.service",
    "kmj-cloudos-worker.service",
    "kmj-codebridge-cloudos.service",
)
LOCK = Path("/run/lock/kmj-cloudos-snap-prune.lock")
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"}


def run(argv, *, timeout=30):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                            check=False, env=ENV)
    if result.returncode != 0:
        raise RuntimeError("COMMAND_FAILED:" + argv[0].rsplit("/", 1)[-1])
    return result.stdout


def parse_snap_list(output):
    """Return name -> list of (revision, disabled). Reject malformed tables."""
    lines = [line.split() for line in output.splitlines() if line.strip()]
    if not lines or lines[0][:3] != ["Name", "Version", "Rev"]:
        raise RuntimeError("SNAP_LIST_HEADER_UNEXPECTED")
    result = {}
    for row in lines[1:]:
        if len(row) < 6:
            raise RuntimeError("SNAP_LIST_ROW_MALFORMED")
        name, revision = row[0], row[2]
        if not revision.isdecimal():
            raise RuntimeError("SNAP_REVISION_UNEXPECTED")
        notes = row[5].split(",")
        result.setdefault(name, []).append((revision, "disabled" in notes))
    return result


def status_for(rows, name, revision):
    versions = rows.get(name, [])
    target = [disabled for rev, disabled in versions if rev == revision]
    if len(target) > 1:
        raise RuntimeError("SNAP_DUPLICATE_REVISION")
    if not target:
        return "ABSENT"
    if not target[0]:
        raise RuntimeError("TARGET_REVISION_IS_ACTIVE")
    if not any(not disabled for _rev, disabled in versions):
        raise RuntimeError("ACTIVE_REPLACEMENT_MISSING")
    return "DISABLED_WITH_ACTIVE_REPLACEMENT"


def identify():
    if os.geteuid() != 0 or os.uname().nodename != HOST:
        raise RuntimeError("WRONG_HOST_OR_NOT_ROOT")
    req = Request("http://metadata.google.internal/computeMetadata/v1/instance/name",
                  headers={"Metadata-Flavor": "Google"})
    with build_opener(ProxyHandler({})).open(req, timeout=6) as response:
        if response.status != 200 or response.read(128).decode().strip() != GCE_NAME:
            raise RuntimeError("WRONG_GCE_IDENTITY")
    print("GOOGLE_VPS_IDENTITY=PASS", flush=True)


def health():
    for service in SERVICES:
        if run(["systemctl", "is-active", service], timeout=10).strip() != "active":
            raise RuntimeError("CLOUDOS_SERVICE_NOT_ACTIVE")
    req = Request("http://127.0.0.1:8080/dashboard")
    with build_opener(ProxyHandler({})).open(req, timeout=5) as response:
        if response.status != 200 or not response.read(1):
            raise RuntimeError("CLOUDOS_DASHBOARD_NOT_HEALTHY")
    print("CLOUDOS_API_WORKER_AGENT_DASHBOARD=PASS", flush=True)


def apply_revisions():
    old_free = shutil.disk_usage("/").free
    rows = parse_snap_list(run(["snap", "list", "--all"], timeout=25))
    selected = []
    for name, revision in TARGETS:
        state = status_for(rows, name, revision)
        print(f"SNAP_PREFLIGHT={name}:{revision}:{state}", flush=True)
        if state == "DISABLED_WITH_ACTIVE_REPLACEMENT":
            selected.append((name, revision))
    return selected, old_free


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    identify()
    lockfd = os.open(LOCK, os.O_CREAT | os.O_WRONLY | os.O_CLOEXEC |
                     getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(lockfd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        health()
        selected, old_free = apply_revisions()
        print("MODE=" + ("APPLY" if args.apply else "READ_ONLY"), flush=True)
        print("SELECTED_REVISION_COUNT=" + str(len(selected)), flush=True)
        if not args.apply:
            print("HOST_CHANGES=NONE")
            return 0
        if not selected:
            print("SNAP_CLEANUP=NO_CHANGES")
            return 0
        for name, revision in selected:
            # Recheck each revision immediately before removal, and fail closed
            # if snapd updated its view or removed the active replacement.
            fresh = parse_snap_list(run(["snap", "list", "--all"], timeout=25))
            if status_for(fresh, name, revision) != "DISABLED_WITH_ACTIVE_REPLACEMENT":
                raise RuntimeError("SNAP_TARGET_CHANGED_STOP")
            health()
            run(["snap", "remove", name, "--revision=" + revision], timeout=240)
            print(f"DISABLED_REVISION_REMOVED={name}:{revision}", flush=True)
            health()
        print("ROOT_SPACE_GAIN_BYTES=" + str(shutil.disk_usage("/").free - old_free),
              flush=True)
        print("SNAP_CLEANUP=PASS", flush=True)
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print("SNAP_CLEANUP=BLOCKED_OR_PARTIAL", file=sys.stderr)
        print("ERROR_CLASS=" + type(error).__name__, file=sys.stderr)
        sys.exit(2)
