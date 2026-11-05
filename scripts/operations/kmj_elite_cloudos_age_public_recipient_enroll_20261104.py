#!/usr/bin/env python3
"""ELITE-only, exact public AGE recipient enrollment; private identity MUST remain off ELITE.

Modes: --self-test (offline), --inspect (read only), --install AGE1 SHA256 (opt-in).
The SHA-256 is of the canonical public recipient plus one LF byte.
No private material is accepted or read; no shell commands or cloud actions.
"""
from __future__ import annotations

import hashlib
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
from pathlib import Path

HOST = "kmj-elite"
PARENT = "kmj-cloudos-backup"
TARGET = "owner-recipient.txt"
PATTERN = re.compile(r"age1[023456789acdefghjklmnpqrstuvwxyz]{55,90}\Z")
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
O_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC


class Blocked(RuntimeError):
    pass


def validate_public(value: str, digest: str | None = None) -> tuple[str, str]:
    if not isinstance(value, str) or not PATTERN.fullmatch(value):
        raise Blocked("PUBLIC_RECIPIENT_INVALID")
    calculated = hashlib.sha256((value + "\n").encode("ascii")).hexdigest()
    if digest is not None and not secrets.compare_digest(calculated, digest.lower()):
        raise Blocked("OWNER_PUBLIC_RECIPIENT_SHA256_MISMATCH")
    return value, calculated


def root_host():
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("EXACT_ELITE_ROOT_REQUIRED")


def trusted_dir(parent_fd: int, name: str, mode: int | None = None) -> int:
    fd = os.open(name, O_DIR, dir_fd=parent_fd)
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        os.close(fd)
        raise Blocked("DIR_ROOT_TRUST_INVALID")
    if mode is not None and stat.S_IMODE(st.st_mode) != mode:
        os.close(fd)
        raise Blocked("DIR_MODE_NOT_0700")
    return fd


def parent_dir(etcfd: int, create: bool = False) -> int | None:
    try:
        return trusted_dir(etcfd, PARENT, 0o700)
    except FileNotFoundError:
        if not create:
            return None
        try:
            os.mkdir(PARENT, 0o700, dir_fd=etcfd)
        except FileExistsError:
            pass  # concurrent creator must still pass strict checks
        return trusted_dir(etcfd, PARENT, 0o700)


def read_installed(dirfd: int) -> tuple[str, str] | None:
    try:
        fd = os.open(TARGET, O_FILE, dir_fd=dirfd)
    except FileNotFoundError:
        return None
    try:
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_nlink != 1
                or stat.S_IMODE(st.st_mode) != 0o600 or not 40 <= st.st_size <= 128):
            raise Blocked("INSTALLED_RECIPIENT_UNTRUSTED")
        b = os.read(fd, 129)
        if len(b) != st.st_size:
            raise Blocked("INSTALLED_RECIPIENT_CHANGED")
        try:
            value = b.decode("ascii", "strict")
        except UnicodeError:
            raise Blocked("INSTALLED_RECIPIENT_NONASCII") from None
        if not value.endswith("\n") or value.count("\n") != 1:
            raise Blocked("INSTALLED_RECIPIENT_NOT_CANONICAL")
        return validate_public(value[:-1])
    finally:
        os.close(fd)


def age_binary() -> str:
    exe = shutil.which("age")
    if not exe:
        raise Blocked("AGE_BINARY_NOT_INSTALLED")
    real = Path(exe).resolve(strict=True)
    s = real.stat()
    if (str(real).startswith(("/usr/bin/", "/usr/local/bin/", "/bin/")) is False
            or not stat.S_ISREG(s.st_mode) or s.st_uid != 0
            or s.st_mode & 0o022 or not s.st_mode & 0o111):
        raise Blocked("AGE_BINARY_TRUST_INVALID")
    return str(real)


def verify_encrypt(value: str) -> None:
    try:
        r = subprocess.run([age_binary(), "-e", "-r", value],
                           input=b"KMJ-CLOUDOS-PUBLIC-ONLY-RECIPIENT-TEST\n",
                           capture_output=True, timeout=12, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("AGE_PUBLIC_ENCRYPTION_UNAVAILABLE") from None
    if (r.returncode != 0 or not r.stdout.startswith(b"age-encryption.org/v1\n")
            or not 80 <= len(r.stdout) <= 8192):
        raise Blocked("AGE_PUBLIC_ENCRYPTION_FAILED")
    print("ELITE_OWNER_AGE_PUBLIC_ENCRYPTION=PASS_MEMORY_ONLY")


def install_new(dirfd: int, public: str) -> None:
    """Create root-only canonical file atomically, refusing overwrite by hardlinking temp."""
    tmp = ".owner-recipient." + secrets.token_hex(12) + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600, dir_fd=dirfd)
    try:
        try:
            os.fchmod(fd, 0o600)
            payload = (public + "\n").encode("ascii")
            if os.write(fd, payload) != len(payload):
                raise Blocked("OWNER_RECIPIENT_SHORT_WRITE")
            os.fsync(fd)
        finally:
            os.close(fd)
        os.link(tmp, TARGET, src_dir_fd=dirfd, dst_dir_fd=dirfd, follow_symlinks=False)
        os.fsync(dirfd)
    finally:
        os.unlink(tmp, dir_fd=dirfd)
        os.fsync(dirfd)


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        sample = "age1gde3ncmahlqd9gg50tanl99r960llztrhfapnmx853s4tjum03uqfssgdh"
        assert validate_public(sample)[0] == sample
        for bad in ("AGE-SECRET-KEY-1", sample + "\n", sample.upper(), "age1bad", sample + " "):
            try:
                validate_public(bad)
            except Blocked:
                pass
            else:
                raise AssertionError("UNSAFE_RECIPIENT_ACCEPTED")
        good_hash = validate_public(sample)[1]
        try:
            validate_public(sample, "0" * 64)
        except Blocked:
            pass
        else:
            raise AssertionError("SHA_MISMATCH_ACCEPTED")
        assert validate_public(sample, good_hash) == (sample, good_hash)
        assert TARGET == "owner-recipient.txt" and PARENT == "kmj-cloudos-backup"
        print("ELITE_OWNER_AGE_ENROLL_OFFLINE_TESTS=PASS")
        return 0
    if argv != ["--inspect"] and (len(argv) != 3 or argv[0] != "--install"):
        print("USAGE: script.py --self-test | --inspect | --install AGE1 SHA256")
        return 64
    try:
        root_host()
        public, digest = validate_public(argv[1], argv[2]) if argv[0] == "--install" else (None, None)
        rootfd = os.open("/", O_DIR)
        try:
            etcfd = trusted_dir(rootfd, "etc")
            try:
                dirfd = parent_dir(etcfd, create=public is not None)
                if dirfd is None:
                    print("ELITE_OWNER_AGE_PUBLIC_RECIPIENT=NOT_INSTALLED")
                    return 0
                try:
                    installed = read_installed(dirfd)
                    if public is None:
                        if installed:
                            print("ELITE_OWNER_AGE_PUBLIC_RECIPIENT=ROOT_0600_VERIFIED")
                            print("ELITE_OWNER_AGE_RECIPIENT_SHA256=" + installed[1])
                        else:
                            print("ELITE_OWNER_AGE_PUBLIC_RECIPIENT=NOT_INSTALLED")
                        return 0
                    if installed:
                        if installed[0] != public:
                            raise Blocked("EXISTING_DIFFERENT_RECIPIENT_NO_OVERWRITE")
                        print("ELITE_OWNER_AGE_PUBLIC_RECIPIENT=EXISTING_MATCH_VERIFIED")
                    else:
                        verify_encrypt(public)
                        try:
                            install_new(dirfd, public)
                        except FileExistsError:
                            raise Blocked("CONCURRENT_FILE_EXISTS_NO_OVERWRITE") from None
                        print("ELITE_OWNER_AGE_PUBLIC_RECIPIENT=PUBLIC_ONLY_CREATED")
                    final = read_installed(dirfd)
                    if final != (public, digest):
                        raise Blocked("INSTALLED_PUBLIC_RECIPIENT_READBACK_MISMATCH")
                    print("ELITE_OWNER_AGE_RECIPIENT_SHA256=" + digest)
                    print("AGE_PRIVATE_IDENTITY=NEVER_READ_NEVER_INSTALLED")
                    print("N2_FULL_BACKUP_AND_INDEPENDENT_RESTORE=NOT_ATTEMPTED")
                    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
                    return 0
                finally:
                    os.close(dirfd)
            finally:
                os.close(etcfd)
        finally:
            os.close(rootfd)
    except (Blocked, OSError, ValueError) as e:
        print("ELITE_OWNER_AGE_PUBLIC_ENROLL=BLOCKED")
        print("ELITE_OWNER_AGE_ENROLL_REASON=" + (str(e) if isinstance(e, Blocked) else "HOST_OR_RUNTIME_FAILURE"))
        print("N2_FULL_BACKUP_AND_INDEPENDENT_RESTORE=NOT_ATTEMPTED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
