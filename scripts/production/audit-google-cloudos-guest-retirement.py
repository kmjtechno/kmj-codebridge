#!/usr/bin/env python3
"""Read-only Google CloudOS guest retirement inventory. Never stops or deletes guests."""
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

HOST = "google-vps1"
NSPAWN_ROOT = Path("/var/lib/machines")
LXD_STORAGE = Path("/var/snap/lxd/common/lxd")
EXPECTED_NS = {"kvm01", "kvm02", "kvm03", "shared01", "shared02", "shared03",
               "util01", "util02", "util03"}
EXPECTED_LXD = {"upg01", "upg02", "upg03"}

def run(argv, timeout=12):
    try:
        p = subprocess.run(argv, text=True, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=timeout,
                           check=False, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"})
        return p.stdout if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None

def file_kind(path):
    try:
        st = path.lstat()
        if stat.S_ISLNK(st.st_mode):
            return "SYMLINK_UNSAFE"
        if stat.S_ISDIR(st.st_mode):
            return "directory"
        return "not_directory"
    except OSError:
        return "missing_or_inaccessible"

def allocated(path):
    if file_kind(path) != "directory":
        return "UNKNOWN"
    output = run(["du", "-s", "-B1", "--", str(path)], timeout=7)
    if output is None:
        return "TIMEOUT_OR_DENIED"
    number = output.split()[0] if output.split() else ""
    return number if number.isdecimal() else "UNKNOWN"

def parse_machinectl():
    raw = run(["machinectl", "list", "--no-legend", "--no-pager"], timeout=15)
    if raw is None:
        return None
    found = {}
    for line in raw.splitlines():
        cells = line.split()
        if len(cells) >= 3 and cells[1] in {"container", "vm"}:
            found[cells[0]] = {"kind": cells[1], "service": cells[2]}
    return found

def parse_lxd():
    raw = run(["lxc", "list", "--format=json"], timeout=20)
    if raw is None:
        return None
    try:
        data = json.loads(raw)
        if not isinstance(data, list):
            return None
        out = {}
        for item in data:
            name = item.get("name")
            if isinstance(name, str) and name and len(name) <= 100:
                out[name] = {"status": str(item.get("status", "UNKNOWN")),
                             "kind": str(item.get("type", "UNKNOWN"))}
        return out
    except (TypeError, ValueError, AttributeError):
        return None

def current_mounts():
    raw = run(["findmnt", "--raw", "--noheadings", "--output", "TARGET"], timeout=10)
    return raw.splitlines() if raw is not None else None

def dependency_state(path, mounts):
    if mounts is None:
        return "MOUNTS_UNVERIFIED"
    target = str(path).rstrip("/")
    if any(m == target or m.startswith(target + "/") for m in mounts):
        return "MOUNT_PRESENT"
    return "NO_DIRECT_MOUNT_SEEN_NOT_PROOF_OF_DISPOSAL"

def main():
    print("KMJ_CLOUDOS_GUEST_RETIREMENT_AUDIT=READ_ONLY")
    print("WRITES=NONE VM_REMOVALS=0 STORAGE_DELETIONS=0")
    print("HOST=" + os.uname().nodename)
    if os.geteuid() != 0 or os.uname().nodename != HOST:
        print("AUDIT=BLOCKED_WRONG_HOST_OR_NOT_ROOT")
        return 2
    for service in ("kmj-cloudos-api.service", "kmj-cloudos-worker.service",
                    "kmj-codebridge-cloudos.service"):
        active = run(["systemctl", "is-active", service], timeout=5)
        print("SERVICE " + service + " " + (active or "UNKNOWN").strip())
    output = run(["df", "-Pk", "/"], timeout=7)
    if output is not None:
        lines = output.splitlines()
        if len(lines) >= 2:
            vals = lines[-1].split()
            if len(vals) >= 5:
                print("ROOT_DISK_AVAIL_KIB=" + vals[3])
                print("ROOT_DISK_USED_PERCENT=" + vals[4])
    machines = parse_machinectl()
    lxd = parse_lxd()
    mounts = current_mounts()
    print("MACHINECTL_DISCOVERY=" + ("PASS" if machines is not None else "UNAVAILABLE"))
    print("LXD_DISCOVERY=" + ("PASS" if lxd is not None else "UNAVAILABLE"))
    print("MOUNT_DISCOVERY=" + ("PASS" if mounts is not None else "UNAVAILABLE"))
    if file_kind(NSPAWN_ROOT) != "directory":
        print("NSPAWN_ROOT=UNAVAILABLE_OR_UNSAFE")
        entries = set()
    else:
        try:
            entries = {p.name for p in NSPAWN_ROOT.iterdir()
                       if not p.name.startswith(".#") and p.is_dir() and not p.is_symlink()}
        except OSError:
            entries = set()
            print("NSPAWN_ROOT_LIST=UNAVAILABLE")
    names = sorted(entries | EXPECTED_NS | (set(machines) if machines is not None else set()))
    for name in names:
        if "/" in name or name in (".", ".."):
            continue
        path = NSPAWN_ROOT / name
        status = ("RUNNING" if machines is not None and name in machines else
                  "NOT_REGISTERED" if machines is not None else "UNVERIFIED")
        kind = machines.get(name, {}).get("kind", "UNKNOWN") if machines is not None else "UNKNOWN"
        mount = dependency_state(path, mounts)
        size = allocated(path)
        decision = "KEEP_RUNNING" if status == "RUNNING" else "REVIEW_ONLY"
        print("NSPAWN name=" + name + " state=" + status + " machine_kind=" + kind +
              " allocated_bytes=" + size + " mount=" + mount +
              " disposition=" + decision + " backup=NOT_VERIFIED")
    names = sorted(EXPECTED_LXD | (set(lxd) if lxd is not None else set()))
    for name in names:
        info = lxd.get(name) if lxd is not None else None
        status = info["status"] if info else "UNVERIFIED_OR_ABSENT"
        kind = info["kind"] if info else "UNKNOWN"
        decision = "KEEP_RUNNING" if status.upper() == "RUNNING" else "REVIEW_ONLY"
        print("LXD name=" + name + " state=" + status + " type=" + kind +
              " disposition=" + decision + " snapshots=NOT_VERIFIED backup=NOT_VERIFIED")
    print("NSPAWN_ALLOCATED_TOTAL_BYTES=" + allocated(NSPAWN_ROOT))
    print("LXD_STORAGE_ALLOCATED_BYTES=" + allocated(LXD_STORAGE))
    print("RELEASE_GATE_USAGE=UNVERIFIED")
    print("EXTERNAL_BACKUP_RESTORE=UNVERIFIED")
    print("SAFE_AUTO_DELETE_COUNT=0")
    print("NEXT=VERIFY_DEPENDENCIES_BACKUPS_AND_TEST_COMPLETION_BEFORE_ANY_RETIREMENT")
    return 0

if __name__ == "__main__":
    sys.exit(main())
