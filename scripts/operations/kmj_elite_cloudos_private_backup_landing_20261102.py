#!/usr/bin/env python3
"""One-path, root-only ELITE backup landing-zone setup for CloudOS lab N2.

This is NOT a backup. It creates at most one fixed 0700 directory directly
under the existing verified root-owned /srv directory. It cannot create user
accounts, keys, secrets, snapshots, restore disks, or transfer data.

Refuses wrong hostname, missing/mounted/symlink /srv, wrong owners, unprivileged
sessions, insufficient storage and unsafe existing directories. Idempotent:
a previously verified private target is left unchanged.
"""
from __future__ import annotations

import os
import stat
import sys

HOST = "kmj-elite"
PARENT = "/srv"
CHILD = "kmj-cloudos-n2-offsite"
DEST = PARENT + "/" + CHILD
REQUIRED_FREE = 65 * 1024 ** 3
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class Blocked(RuntimeError):
    pass


def require_directory(st: os.stat_result, *, private: bool) -> None:
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0:
        raise Blocked("DIRECTORY_NOT_ROOT_OWNED")
    if private and stat.S_IMODE(st.st_mode) != 0o700:
        raise Blocked("TARGET_MODE_NOT_EXACTLY_0700")
    if not private and st.st_mode & 0o022:
        raise Blocked("PARENT_IS_GROUP_OR_WORLD_WRITABLE")


def candidate_space(fs) -> int:
    total = fs.f_blocks * fs.f_frsize
    free = fs.f_bavail * fs.f_frsize
    if not 0 < free <= total <= 100 * (1024 ** 5):
        raise Blocked("INVALID_FILESYSTEM_CAPACITY")
    if free < REQUIRED_FREE:
        raise Blocked("LESS_THAN_65GIB_AVAILABLE")
    return free


def main() -> int:
    if sys.argv[1:] != ["--prepare"]:
        print("USAGE: script.py --prepare")
        return 64
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        print("ELITE_BACKUP_LANDING=BLOCKED_HOST_OR_ROOT")
        return 2
    root_fd = None
    parent_fd = None
    child_fd = None
    mutation_attempted = False
    try:
        root_fd = os.open("/", O_DIR)
        root = os.fstat(root_fd)
        require_directory(root, private=False)
        parent_fd = os.open("srv", O_DIR, dir_fd=root_fd)
        parent = os.fstat(parent_fd)
        require_directory(parent, private=False)
        if parent.st_dev != root.st_dev:
            raise Blocked("REFUSE_UNEXPECTED_SRV_MOUNT")
        free = candidate_space(os.fstatvfs(parent_fd))
        print("ELITE_HOST_AND_SRV_PARENT=VERIFIED")
        print("ELITE_SRV_FREE_BYTES_BEFORE=" + str(free))
        print("ELITE_BACKUP_LANDING_PATH=" + DEST)
        try:
            os.stat(CHILD, dir_fd=parent_fd, follow_symlinks=False)
            existed = True
        except FileNotFoundError:
            existed = False
        if not existed:
            mutation_attempted = True
            os.mkdir(CHILD, 0o700, dir_fd=parent_fd)
            status = "CREATED_PRIVATE"
        else:
            status = "PREEXISTING_PRIVATE_UNMODIFIED"
        child_fd = os.open(CHILD, O_DIR, dir_fd=parent_fd)
        target = os.fstat(child_fd)
        require_directory(target, private=True)
        if target.st_dev != parent.st_dev:
            raise Blocked("TARGET_ON_UNEXPECTED_FILESYSTEM")
        if target.st_nlink < 2:
            raise Blocked("TARGET_LINK_COUNT_UNEXPECTED")
        if not existed and os.listdir(child_fd):
            raise Blocked("CREATED_TARGET_NOT_EMPTY")
        print("ELITE_BACKUP_LANDING=" + status)
        print("ELITE_BACKUP_LANDING_OWNER=ROOT_VERIFIED")
        print("ELITE_BACKUP_LANDING_MODE=0700_VERIFIED")
        print("ELITE_BACKUP_LANDING_FILESYSTEM=SAME_AS_SRV")
        print("N2_BOOT_DISK_SOURCE_CAPTURE=NOT_ATTEMPTED")
        print("OFFSITE_ENCRYPTED_TRANSFER=NOT_ATTEMPTED")
        print("INDEPENDENT_RESTORE_AND_ROLLBACK=NOT_VERIFIED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 0
    except (Blocked, OSError) as err:
        print("ELITE_BACKUP_LANDING=BLOCKED")
        print("ELITE_BACKUP_LANDING_REASON=" +
              (str(err)[:100] if isinstance(err, Blocked)
               else "FILESYSTEM_OPERATION_FAILED"))
        print("ELITE_DIRECTORY_CREATION_ATTEMPTED=" +
              ("YES_RECHECK_WITH_AUDIT" if mutation_attempted else "NO"))
        print("N2_BOOT_DISK_SOURCE_CAPTURE=NOT_ATTEMPTED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2
    finally:
        for fd in (child_fd, parent_fd, root_fd):
            if fd is not None:
                os.close(fd)


def self_test() -> int:
    import types
    fake = lambda mode, owner: types.SimpleNamespace(st_mode=mode, st_uid=owner)
    require_directory(fake(stat.S_IFDIR | 0o755, 0), private=False)
    require_directory(fake(stat.S_IFDIR | 0o700, 0), private=True)
    for mode, owner, private in (
        (stat.S_IFLNK | 0o777, 0, False),
        (stat.S_IFDIR | 0o777, 0, False),
        (stat.S_IFDIR | 0o755, 0, True),
        (stat.S_IFDIR | 0o750, 0, True),
        (stat.S_IFDIR | 0o700, 1001, True),
    ):
        try:
            require_directory(fake(mode, owner), private=private)
        except Blocked:
            pass
        else:
            raise AssertionError("Unsafe existing path was accepted")
    fsv = lambda blocks, avail: types.SimpleNamespace(
        f_blocks=blocks, f_bavail=avail, f_frsize=1024 ** 3)
    assert candidate_space(fsv(100, 65)) == REQUIRED_FREE
    for fs in (fsv(100, 64), fsv(100, 101), fsv(0, 0)):
        try:
            candidate_space(fs)
        except Blocked:
            pass
        else:
            raise AssertionError("Unsafe free-space allowance was accepted")
    assert DEST == "/srv/kmj-cloudos-n2-offsite"
    print("ELITE_PRIVATE_BACKUP_LANDING_OFFLINE_TESTS=PASS")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        raise SystemExit(self_test())
    raise SystemExit(main())
