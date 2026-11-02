#!/usr/bin/env python3
"""Read-only KMJ-elite SSH/crypto receiver preflight for N2 CloudOS recovery.

No network connections, filesystem writes, key generation, transfers, sudo,
service changes, VM starts, or backup claims. Prints ONLY the server's public
ED25519 key fingerprint, never private keys/credentials.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

HOST = "kmj-elite"
ROOT = Path("/")
SRV = Path("/srv")
TARGET = SRV / "kmj-cloudos-n2-offsite"
SSH_PUBLIC = Path("/etc/ssh/ssh_host_ed25519_key.pub")
MIN_FREE = 65 * (1024 ** 3)
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FINGERPRINT = re.compile(r"SHA256:[A-Za-z0-9+/]{20,100}\Z")


class Blocked(Exception):
    pass


def require_dir(fd: int, mode: int | None = None) -> os.stat_result:
    s = os.fstat(fd)
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0:
        raise Blocked("ROOT_OWNED_REAL_DIRECTORY_REQUIRED")
    if mode is not None and stat.S_IMODE(s.st_mode) != mode:
        raise Blocked("PRIVATE_DIRECTORY_EXACT_MODE_REQUIRED")
    if mode is None and s.st_mode & 0o022:
        raise Blocked("PUBLIC_WRITE_FORBIDDEN")
    return s


def run_readonly(argv: list[str], *, seconds: int = 8) -> tuple[bool, str]:
    try:
        p = subprocess.run(
            argv, capture_output=True, text=True, timeout=seconds, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, ""
    if p.returncode or len(p.stdout.encode("utf-8")) > 16384:
        return False, ""
    return True, p.stdout.strip()


def public_fingerprint() -> str | None:
    try:
        st = SSH_PUBLIC.lstat()
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or
                st.st_size < 60 or st.st_size > 1000):
            return None
    except OSError:
        return None
    if not shutil.which("ssh-keygen"):
        return None
    ok, output = run_readonly(
        ["ssh-keygen", "-l", "-E", "sha256", "-f", str(SSH_PUBLIC)]
    )
    if not ok or len(output.splitlines()) != 1:
        return None
    pieces = output.split()
    if len(pieces) < 3 or not FINGERPRINT.fullmatch(pieces[1]):
        return None
    return pieces[1]


def listen_port22() -> str:
    if not shutil.which("ss"):
        return "UNKNOWN_TOOL_MISSING"
    ok, output = run_readonly(["ss", "-H", "-ltn", "sport = :22"])
    if not ok:
        return "UNKNOWN_QUERY_FAILED"
    return "YES_LOCAL_ONLY" if output else "NO_LOCAL_LISTENER"


def inspect() -> int:
    if os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("WRONG_HOST")
    if os.geteuid() != 0:
        raise Blocked("ROOT_REQUIRED_FOR_TRUSTED_LOCAL_READ")
    fd = []
    try:
        fd.append(os.open("/", O_DIR))
        root = require_dir(fd[-1])
        fd.append(os.open("srv", O_DIR, dir_fd=fd[-1]))
        srv = require_dir(fd[-1])
        fd.append(os.open("kmj-cloudos-n2-offsite", O_DIR, dir_fd=fd[-1]))
        target = require_dir(fd[-1], mode=0o700)
        if root.st_dev != srv.st_dev or srv.st_dev != target.st_dev:
            raise Blocked("UNEXPECTED_SRV_TARGET_MOUNT")
        vfs = os.fstatvfs(fd[1])
        free = vfs.f_bavail * vfs.f_frsize
        total = vfs.f_blocks * vfs.f_frsize
        if not (MIN_FREE <= free <= total <= 100 * (1024 ** 5)):
            raise Blocked("INSUFFICIENT_OR_INVALID_FREE_SPACE")
        print("ELITE_HOST_IDENTITY=VERIFIED")
        print("ELITE_PRIVATE_BACKUP_LANDING=ROOT_0700_NOFOLLOW_PASS")
        print("ELITE_TARGET_FREE_BYTES=" + str(free))
        print("ELITE_RECEIVER_SSH_SERVICE=" +
              ("ACTIVE_LOCAL_ONLY" if run_readonly(["systemctl", "is-active", "ssh"])[1] == "active"
               else "NOT_VERIFIED_ACTIVE"))
        print("ELITE_SSH_PORT22_LISTENER=" + listen_port22())
        fingerprint = public_fingerprint()
        print("ELITE_ED25519_PUBLIC_HOST_FINGERPRINT=" +
              (fingerprint if fingerprint else "UNAVAILABLE"))
        for tool in ("ssh", "ssh-keygen", "rsync", "zstd", "age", "sha256sum"):
            print("ELITE_TOOL_" + tool.upper().replace("-", "_") + "=" +
                  ("PRESENT" if shutil.which(tool) else "MISSING"))
        print("N2_TO_ELITE_NETWORK_REACHABILITY=NOT_TESTED")
        print("N2_TO_ELITE_HOST_KEY_PINNING=NOT_CONFIGURED_OR_VERIFIED")
        print("N2_TO_ELITE_RESTRICTED_UPLOAD_IDENTITY=NOT_VERIFIED")
        print("OFFSITE_AGE_RECIPIENT_AND_RECOVERY_KEY=NOT_VERIFIED")
        print("CONSISTENT_N2_BOOTABLE_SOURCE_CAPTURE=NOT_VERIFIED")
        print("ENCRYPTED_BACKUP_STREAM=NOT_ATTEMPTED")
        print("DISPOSABLE_RESTORE_ROLLBACK=NOT_VERIFIED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        print("ELITE_TRANSPORT_CRYPTO_PREFLIGHT=READ_ONLY_COMPLETE")
        return 0
    finally:
        for f in reversed(fd):
            os.close(f)


def self_test() -> int:
    assert FINGERPRINT.fullmatch("SHA256:" + "a" * 43)
    assert not FINGERPRINT.fullmatch("SHA256:unsafe key")
    assert not FINGERPRINT.fullmatch("MD5:" + "a" * 43)
    assert str(TARGET) == "/srv/kmj-cloudos-n2-offsite"
    assert MIN_FREE == 65 * (1024 ** 3)
    assert O_DIR & os.O_NOFOLLOW
    print("ELITE_TRANSPORT_CRYPTO_OFFLINE_TESTS=PASS")
    return 0


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    if sys.argv[1:] != ["--inspect"]:
        print("USAGE: script.py --inspect")
        return 64
    try:
        return inspect()
    except (Blocked, OSError) as exc:
        print("ELITE_TRANSPORT_CRYPTO_PREFLIGHT=BLOCKED")
        print("ELITE_REASON=" + (str(exc)[:100] if isinstance(exc, Blocked)
                                else "LOCAL_READ_FAILED"))
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
