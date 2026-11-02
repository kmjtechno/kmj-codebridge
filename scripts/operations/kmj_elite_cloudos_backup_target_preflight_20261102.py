#!/usr/bin/env python3
"""KMJ ELITE CloudOS offsite landing-zone readiness -- READ-ONLY.

Host operator may run "--inspect" as root or a normal user. This probes only
the fixed /srv tree, filesystem free bytes and availability of backup/restore
utilities. It never provisions a directory, changes permissions, connects to
N2, transfers content, starts a hypervisor, or runs any shell command.

A positive capacity receipt is NOT a backup, a durable target reservation, a
completed encryption/transfer, or a verified disposable restore.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import stat
import sys

HOST = "kmj-elite"
PARENT = Path("/srv")
DEST = PARENT / "kmj-cloudos-n2-offsite"
GIB = 1024 ** 3
RAW_WITH_RESERVE = 35 * GIB
TWO_RAW_IMAGES_WITH_RESERVE = 65 * GIB
TOOLS = ("tar", "sha256sum", "ssh", "rsync", "zstd", "age", "openssl",
         "qemu-img", "qemu-system-x86_64", "virsh")


class Blocked(RuntimeError):
    pass


def check_dir_stat(st: os.stat_result, *, private: bool) -> None:
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0:
        raise Blocked("DIRECTORY_NOT_ROOT_OWNED_REAL_DIRECTORY")
    if private:
        if st.st_mode & 0o077:
            raise Blocked("BACKUP_DESTINATION_NOT_PRIVATE_0700")
    elif st.st_mode & 0o022:
        raise Blocked("BACKUP_PARENT_GROUP_OR_WORLD_WRITABLE")


def inspect() -> int:
    if os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("NOT_EXACT_ELITE_HOST")
    parent_st = PARENT.lstat()
    check_dir_stat(parent_st, private=False)
    if os.path.realpath(PARENT) != str(PARENT):
        raise Blocked("PARENT_SYMLINK_OR_NONCANONICAL")
    root_st = Path("/").lstat()
    check_dir_stat(root_st, private=False)
    try:
        target_st = DEST.lstat()
    except FileNotFoundError:
        target_st = None
    if target_st is not None:
        check_dir_stat(target_st, private=True)
        if target_st.st_dev != parent_st.st_dev:
            raise Blocked("UNEXPECTED_EXISTING_DESTINATION_MOUNT")
    fs = os.statvfs(PARENT)
    free = fs.f_bavail * fs.f_frsize
    total = fs.f_blocks * fs.f_frsize
    if (not (0 < free <= total <= 100 * (1024 ** 5))
            or parent_st.st_dev != root_st.st_dev):
        raise Blocked("UNVERIFIED_ROOT_FILESYSTEM_OR_CAPACITY")
    print("ELITE_BACKUP_TARGET_HOST=EXACT_IDENTITY_VERIFIED")
    print("ELITE_BACKUP_PARENT=/srv")
    print("ELITE_BACKUP_PARENT_GUARD=ROOT_OWNED_NO_SYMLINK_NO_PUBLIC_WRITE_PASS")
    print("ELITE_BACKUP_TARGET=" + str(DEST))
    print("ELITE_BACKUP_TARGET_STATE=" + (
        "ABSENT_NOT_CREATED" if target_st is None
        else "EXISTING_ROOT_OWNED_PRIVATE_DIRECTORY"
    ))
    print("ELITE_PARENT_FILESYSTEM_FREE_BYTES=" + str(free))
    print("ELITE_RAW_BACKUP_HEADROOM=" + (
        "PASS_SIZE_ONLY" if free >= RAW_WITH_RESERVE else "BLOCKED_SPACE"
    ))
    print("ELITE_RAW_BACKUP_AND_SEPARATE_RESTORE_HEADROOM=" + (
        "PASS_SIZE_ONLY" if free >= TWO_RAW_IMAGES_WITH_RESERVE
        else "BLOCKED_SPACE"
    ))
    for name in TOOLS:
        print("ELITE_TOOL_" + name.upper().replace("-", "_") + "=" +
              ("PRESENT" if shutil.which(name) else "MISSING"))
    print("ELITE_BACKUP_TARGET_PROVISIONED=" +
          ("YES_PREEXISTING" if target_st else "NO"))
    print("ELITE_BACKUP_DESTINATION_OWNER_APPROVED=NOT_ESTABLISHED")
    print("ELITE_SOURCE_CAPTURE_CONSISTENCY=NOT_VERIFIED")
    print("ELITE_N2_SSH_TRANSPORT_AND_HOST_PIN=NOT_VERIFIED")
    print("ELITE_BACKUP_ENCRYPTION_AND_INTEGRITY=NOT_VERIFIED")
    print("ELITE_INDEPENDENT_DISPOSABLE_RESTORE=NOT_VERIFIED")
    print("CLOUDOS_COMMERCIAL_RELEASE=BLOCKED")
    print("ELITE_BACKUP_TARGET_PREFLIGHT=READ_ONLY_COMPLETE")
    print("ELITE_HOST_AND_GCE_MUTATIONS=NONE")
    return 0


def self_test() -> int:
    import types
    mk = lambda mode, owner: types.SimpleNamespace(st_mode=mode, st_uid=owner)
    check_dir_stat(mk(stat.S_IFDIR | 0o755, 0), private=False)
    check_dir_stat(mk(stat.S_IFDIR | 0o700, 0), private=True)
    for sample, private in (
        (mk(stat.S_IFLNK | 0o777, 0), False),
        (mk(stat.S_IFDIR | 0o777, 0), False),
        (mk(stat.S_IFDIR | 0o755, 0), True),
        (mk(stat.S_IFDIR | 0o700, 1001), True),
        (mk(stat.S_IFREG | 0o600, 0), True),
    ):
        try:
            check_dir_stat(sample, private=private)
        except Blocked:
            pass
        else:
            raise AssertionError("Unsafe backup directory accepted")
    assert RAW_WITH_RESERVE == 35 * GIB
    assert TWO_RAW_IMAGES_WITH_RESERVE == 65 * GIB
    assert str(DEST) == "/srv/kmj-cloudos-n2-offsite"
    print("ELITE_BACKUP_TARGET_OFFLINE_GUARDS=PASS")
    return 0


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    if sys.argv[1:] != ["--inspect"]:
        print("USAGE: script.py --inspect")
        return 64
    try:
        return inspect()
    except (OSError, Blocked) as exc:
        print("ELITE_BACKUP_TARGET_PREFLIGHT=BLOCKED")
        if isinstance(exc, Blocked):
            print("ELITE_BLOCKED_REASON=" + str(exc)[:120])
        print("ELITE_HOST_AND_GCE_MUTATIONS=NONE")
        print("CLOUDOS_COMMERCIAL_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
