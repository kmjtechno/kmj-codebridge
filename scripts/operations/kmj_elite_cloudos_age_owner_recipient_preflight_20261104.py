#!/usr/bin/env python3
"""Read-only CloudOS ELITE owner AGE recipient and backup-vault preflight.

Exact root@KMJ-elite only; reads just one root-owned public recipient file.
A private AGE identity must remain under owner custody OFF the ELITE host.

--inspect has no file, service, VM, network or cloud mutations. It can
exercise an in-memory AGE public-key encryption of a constant test string
(without storing ciphertext). No decrypt/restore claims are made.

Missing public recipient is reported as NOT_INSTALLED; never invent keys.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

HOST = "kmj-elite"
CONFIG_PARENT = "kmj-cloudos-backup"
PUBLIC_FILE = "owner-recipient.txt"
VAULT = "kmj-cloudos-n2-offsite"
EXPECTED_FILE = "/etc/kmj-cloudos-backup/owner-recipient.txt"
REQUIRED_SPACE = 65 * 1024 ** 3
PUBLIC_KEY = re.compile(r"age1[023456789acdefghjklmnpqrstuvwxyz]{55,90}\Z")
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
O_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC


class Blocked(RuntimeError):
    pass


def directory(parentfd, name, mode=None):
    fd = os.open(name, O_DIR, dir_fd=parentfd)
    st = os.fstat(fd)
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid != 0
            or st.st_mode & 0o022):
        os.close(fd)
        raise Blocked("ROOT_DIRECTORY_TRUST_OR_MODE_INVALID")
    if mode is not None and stat.S_IMODE(st.st_mode) != mode:
        os.close(fd)
        raise Blocked("PRIVATE_DIRECTORY_MODE_NOT_0700")
    return fd


def safe_recipient(data):
    if not (40 <= len(data) <= 128):
        raise Blocked("OWNER_PUBLIC_RECIPIENT_SIZE_INVALID")
    try:
        key = data.decode("ascii", "strict").strip()
    except UnicodeDecodeError:
        raise Blocked("OWNER_PUBLIC_RECIPIENT_NONASCII") from None
    if data not in ((key + "\n").encode("ascii"), key.encode("ascii")):
        raise Blocked("OWNER_PUBLIC_RECIPIENT_NOT_SINGLE_CANONICAL_LINE")
    if (not PUBLIC_KEY.fullmatch(key) or key.startswith("AGE-SECRET-KEY")
            or any(c.isspace() for c in key)):
        raise Blocked("OWNER_PUBLIC_RECIPIENT_FORMAT_INVALID")
    return key


def public_receipt(etc):
    try:
        parent = directory(etc, CONFIG_PARENT, mode=0o700)
    except FileNotFoundError:
        return None
    try:
        try:
            fd = os.open(PUBLIC_FILE, O_FILE, dir_fd=parent)
        except FileNotFoundError:
            return None
        try:
            st = os.fstat(fd)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != 0
                    or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600
                    or not 40 <= st.st_size <= 128):
                raise Blocked("OWNER_PUBLIC_RECIPIENT_FILE_UNTRUSTED")
            data = os.read(fd, 129)
            if len(data) != st.st_size:
                raise Blocked("OWNER_PUBLIC_RECIPIENT_CONTENT_CHANGED")
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    recipient = safe_recipient(data)
    return recipient, hashlib.sha256((recipient + "\n").encode("ascii")).hexdigest()


def vault_receipt(srv, rootfs):
    try:
        fd = directory(srv, VAULT, mode=0o700)
    except FileNotFoundError:
        raise Blocked("BACKUP_VAULT_MISSING") from None
    try:
        st = os.fstat(fd)
        if st.st_dev != rootfs:
            raise Blocked("BACKUP_VAULT_UNEXPECTED_MOUNT")
        fs = os.fstatvfs(fd)
        free = fs.f_bavail * fs.f_frsize
        total = fs.f_blocks * fs.f_frsize
        if not (0 < free <= total <= 100 * 1024 ** 5):
            raise Blocked("BACKUP_VAULT_CAPACITY_UNTRUSTED")
        print("ELITE_N2_PRIVATE_BACKUP_VAULT=ROOT_0700_VERIFIED", flush=True)
        print("ELITE_BACKUP_VAULT_FREE_BYTES=" + str(free), flush=True)
        print("ELITE_BACKUP_AND_RESTORE_RAW_SIZE_HEADROOM=" +
              ("PASS_SIZE_ONLY" if free >= REQUIRED_SPACE else
               "BLOCKED_INSUFFICIENT_65GIB"), flush=True)
        return free
    finally:
        os.close(fd)


def age_executable():
    candidate = shutil.which("age")
    if candidate is None:
        raise Blocked("AGE_BINARY_NOT_INSTALLED")
    real = Path(candidate).resolve(strict=True)
    st = real.stat()
    if (not stat.S_ISREG(st.st_mode) or st.st_uid != 0
            or st.st_mode & 0o022 or not st.st_mode & 0o111):
        raise Blocked("AGE_BINARY_PROVENANCE_OR_MODE_INVALID")
    if candidate != str(real):
        # PATH symlinks are common for the distributor. The trusted resolved
        # executable itself must be root-owned and non-public-writable.
        if not str(real).startswith(("/usr/bin/", "/usr/local/bin/", "/bin/")):
            raise Blocked("AGE_BINARY_LOCATION_UNTRUSTED")
    if not str(real).startswith(("/usr/bin/", "/usr/local/bin/", "/bin/")):
        raise Blocked("AGE_BINARY_LOCATION_UNTRUSTED")
    return str(real)


def verify_public_encrypt(executable, recipient):
    try:
        result = subprocess.run(
            [executable, "-e", "-r", recipient],
            input=b"KMJ-CLOUDOS-OWNER-RECOVERY-KEY-PUBLIC-PREFLIGHT-V1\n",
            capture_output=True, timeout=12, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("AGE_PUBLIC_ENCRYPTION_UNAVAILABLE") from None
    if (result.returncode != 0 or len(result.stdout) > 8192
            or not result.stdout.startswith(b"age-encryption.org/v1\n")):
        raise Blocked("AGE_PUBLIC_RECIPIENT_ENCRYPTION_FAILED")
    print("ELITE_OWNER_AGE_PUBLIC_ENCRYPTION=PASS_MEMORY_ONLY", flush=True)


def inspect():
    if (os.geteuid() != 0
            or os.uname().nodename.split(".")[0].lower() != HOST):
        raise Blocked("EXACT_ELITE_ROOT_REQUIRED")
    root = os.open("/", O_DIR)
    try:
        fsroot = os.fstat(root)
        if not stat.S_ISDIR(fsroot.st_mode) or fsroot.st_uid != 0:
            raise Blocked("ROOT_FILESYSTEM_NOT_TRUSTED")
        srv = directory(root, "srv")
        try:
            vault_receipt(srv, fsroot.st_dev)
        finally:
            os.close(srv)
        etc = directory(root, "etc")
        try:
            result = public_receipt(etc)
        finally:
            os.close(etc)
    finally:
        os.close(root)
    print("ELITE_N2_AGE_OWNER_PRIVATE_IDENTITY=NOT_ON_ELITE_NOT_READ", flush=True)
    if result is None:
        print("ELITE_OWNER_AGE_PUBLIC_RECIPIENT=NOT_INSTALLED", flush=True)
        print("ELITE_OWNER_AGE_PUBLIC_ENCRYPTION=NOT_ATTEMPTED", flush=True)
    else:
        recipient, fingerprint = result
        print("ELITE_OWNER_AGE_PUBLIC_RECIPIENT=ROOT_0600_VERIFIED", flush=True)
        print("ELITE_OWNER_AGE_RECIPIENT_SHA256=" + fingerprint, flush=True)
        verify_public_encrypt(age_executable(), recipient)
    print("OWNER_INDEPENDENT_PRIVATE_KEY_RECOVERY=NOT_VERIFIED", flush=True)
    print("N2_CONSISTENT_FULL_DISK_BACKUP=NOT_ATTEMPTED", flush=True)
    print("INDEPENDENT_N2_DISPOSABLE_BOOT_RESTORE=NOT_VERIFIED", flush=True)
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)


def self_test():
    sample = "age1gde3ncmahlqd9gg50tanl99r960llztrhfapnmx853s4tjum03uqfssgdh"
    assert safe_recipient((sample + "\n").encode("ascii")) == sample
    for bad in (
        b"AGE-SECRET-KEY-1example\n",
        b"age1notvalid\n",
        (sample + "\n" + sample + "\n").encode(),
        (sample + " \n").encode(),
        (sample.upper() + "\n").encode(),
    ):
        try:
            safe_recipient(bad)
        except Blocked:
            pass
        else:
            raise AssertionError("INVALID_AGE_RECIPIENT_ACCEPTED")
    assert EXPECTED_FILE == "/etc/kmj-cloudos-backup/owner-recipient.txt"
    assert REQUIRED_SPACE == 65 * 1024 ** 3
    print("ELITE_OWNER_AGE_RECIPIENT_PREFLIGHT_OFFLINE_TESTS=PASS", flush=True)


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:] != ["--inspect"]:
        print("USAGE: script.py --self-test | --inspect")
        return 64
    try:
        inspect()
        return 0
    except (Blocked, OSError, ValueError) as exc:
        print("ELITE_OWNER_AGE_RECIPIENT_PREFLIGHT=BLOCKED", flush=True)
        print("ELITE_OWNER_AGE_BLOCKER=" +
              (str(exc)[:100] if isinstance(exc, Blocked)
               else "FILESYSTEM_OR_RUNTIME_UNAVAILABLE"), flush=True)
        print("ELITE_HOST_AND_GCE_MUTATIONS=NONE", flush=True)
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
