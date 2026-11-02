#!/usr/bin/env python3
"""Read-only KMJ-elite offsite capacity discovery for CloudOS N2 recovery planning.

This reports *free bytes*, not a backup plan, a tested restore, or approval to
write to a production filesystem. Never starts N2, sends data, creates dirs,
writes disk contents, touches services, or mutates a VM.

Run only on exact KMJ-elite host using --inspect. No sudo requirement.
"""
from __future__ import annotations

import os
from pathlib import Path
import stat
import sys

EXPECTED_HOST = "kmj-elite"
N2_BOOT_DISK_GIB = 30
GIB = 1024 ** 3
# Block-level 30 GiB disk image + conservative free-space safety reserve.
RAW_TARGET_BYTES = (N2_BOOT_DISK_GIB + 5) * GIB
# Keep both full raw image AND distinct full-image disposable restore.
FULL_RESTORE_TARGET_BYTES = (2 * N2_BOOT_DISK_GIB + 5) * GIB
CANDIDATES = (
    "/",
    "/home",
    "/srv",
    "/var/backups",
    "/var/lib/libvirt/images",
    "/mnt",
    "/media",
)


class Blocked(Exception):
    pass


def one_filesystem(path: str) -> tuple[int, int] | None:
    p = Path(path)
    try:
        st = p.lstat()
        if not stat.S_ISDIR(st.st_mode):
            return None
        fs = os.statvfs(p)
        free = fs.f_bavail * fs.f_frsize
        total = fs.f_blocks * fs.f_frsize
        if not (0 <= free <= total < 100 * 1024 ** 5):
            raise Blocked("FILESYSTEM_STAT_IMPLAUSIBLE")
        return st.st_dev, free
    except (FileNotFoundError, PermissionError, NotADirectoryError):
        return None


def choose(rows: list[tuple[str, int, int]]) -> tuple[str, int] | None:
    if not rows:
        return None
    if any(type(path) is not str or type(dev) is not int or
           type(free) is not int or free < 0
           for path, dev, free in rows):
        raise Blocked("INVALID_STORAGE_ROW")
    # Filesystem dedup: /home, /mnt etc may be directories on the same disk.
    distinct = {}
    for path, dev, free in rows:
        if dev in distinct:
            if distinct[dev][1] != free:
                raise Blocked("INCONSISTENT_FILESYSTEM_FREE_BYTES")
        else:
            distinct[dev] = (path, free)
    return max(distinct.values(), key=lambda row: row[1])


def inspect() -> int:
    host = os.uname().nodename.split(".")[0].lower()
    if host != EXPECTED_HOST:
        raise Blocked("NOT_EXACT_ELITE_HOST")
    rows = []
    for path in CANDIDATES:
        current = one_filesystem(path)
        if current is not None:
            dev, free = current
            rows.append((path, dev, free))
    best = choose(rows)
    if best is None:
        raise Blocked("NO_READABLE_FILESYSTEM")
    best_path, best_free = best
    print("ELITE_HOST_IDENTITY=VERIFIED")
    print("ELITE_DISTINCT_FILESYSTEMS_INSPECTED=" + str(len({x[1] for x in rows})))
    print("ELITE_LARGEST_VERIFIED_FREE_BYTES=" + str(best_free))
    print("ELITE_LARGEST_FREE_FILESYSTEM_PATH=" + best_path)
    print("N2_NOMINAL_BOOT_DISK_BYTES=" + str(N2_BOOT_DISK_GIB * GIB))
    print("RAW_BACKUP_PLUS_HEADROOM_BYTES=" + str(RAW_TARGET_BYTES))
    print("BACKUP_AND_DISPOSABLE_RESTORE_HEADROOM_BYTES=" +
          str(FULL_RESTORE_TARGET_BYTES))
    print("ELITE_RAW_BACKUP_CAPACITY_CANDIDATE=" +
          ("SIZE_THRESHOLD_MET" if best_free >= RAW_TARGET_BYTES
           else "SIZE_THRESHOLD_NOT_MET"))
    print("ELITE_BACKUP_PLUS_DISPOSABLE_RESTORE_CAPACITY_CANDIDATE=" +
          ("SIZE_THRESHOLD_MET" if best_free >= FULL_RESTORE_TARGET_BYTES
           else "SIZE_THRESHOLD_NOT_MET"))
    print("ELITE_FILESYSTEM_LOCALITY_AND_DURABILITY=NOT_VERIFIED")
    print("ELITE_AUTHORIZED_BACKUP_DESTINATION=NOT_ESTABLISHED")
    print("ELITE_TRANSFER_PERMISSIONS_AND_BANDWIDTH=NOT_VERIFIED")
    print("ELITE_CURRENT_FREE_SPACE_IS_NOT_EXCLUSIVE_OR_RESERVED=YES")
    print("ELITE_INDEPENDENT_RESTORE=NOT_VERIFIED")
    print("N2_BACKUP_GATE=BLOCKED")
    print("CHANGES_TO_ELITE_HOST_OR_GCE=NONE")
    return 0


def self_test() -> int:
    assert RAW_TARGET_BYTES == 35 * GIB
    assert FULL_RESTORE_TARGET_BYTES == 65 * GIB
    assert choose([("/", 1, 42), ("/home", 1, 42), ("/mnt", 2, 99)]) == (
        "/mnt", 99
    )
    assert choose([]) is None
    assert choose([("/", 1, 15), ("/home", 1, 15)])[1] == 15
    for invalid in ([("/", 1, -1)], [("/", 1, 100), ("/home", 1, 101)],
                    [("/", "1", 100)]):
        try:
            choose(invalid)
        except Blocked:
            pass
        else:
            raise AssertionError("Invalid capacity was not blocked")
    print("ELITE_OFFSITE_CAPACITY_OFFLINE_TESTS=PASS")
    return 0


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    if sys.argv[1:] != ["--inspect"]:
        print("USAGE: python3 script.py --inspect")
        return 64
    try:
        return inspect()
    except (Blocked, OSError, OverflowError) as exc:
        print("ELITE_CAPACITY_AUDIT=BLOCKED")
        if isinstance(exc, Blocked):
            print("ELITE_AUDIT_REASON=" + str(exc)[:100])
        print("N2_BACKUP_GATE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
