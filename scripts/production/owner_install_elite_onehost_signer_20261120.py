#!/usr/bin/env python3
"""One-time owner-root installer for an immutable Elite-only NONROOT signer.

Never copies, generates or opens a private key, GitHub token or approval policy.
No signer start, network call, deploy, timer, release or production mutation.
Dry run by default. --apply requires explicit owner confirmation.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import pwd
import socket
import stat
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SRC_ROOT = HERE.parent
TARGET = Path("/usr/local/libexec/kmj-codebridge-elite-signer")
ACCOUNT = "kmjsigner"
HOME = Path("/var/lib/kmj-codebridge-signer")
CONFIRM = "--confirm-elite-nonroot-signer-owner-go"
PINNED = {
    ("production", "owner-auto-sign-stable.mjs"): (
        HERE / "owner-auto-sign-stable.mjs",
        "939c45ce8a3b9dad2ca1e66c4cbdf2314f48d724c18de65a4980e79bab33f749",
    ),
    ("production", "elite-onehost-release.mjs"): (
        HERE / "elite-onehost-release.mjs",
        "bc036efb5ddc92e0d5136769dc492a0cc8620d13a9b45f9076be33e9db4b8f8a",
    ),
    ("", "release-ci-gate.mjs"): (
        SRC_ROOT / "release-ci-gate.mjs",
        "da76cec89e2384a8c8c3126020bdded3b4955de53e8bfca6882fc446742436c1",
    ),
}


class Blocked(Exception):
    pass


def require(cond: bool, code: str) -> None:
    if not cond:
        raise Blocked(code)


def verified_bytes(source: Path, expected: str) -> bytes:
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and 100 < before.st_size < 100000, "SOURCE_UNTRUSTED")
        buf = bytearray()
        while len(buf) < before.st_size:
            part = os.read(fd, min(65536, before.st_size - len(buf)))
            require(len(part) > 0, "SHORT_SOURCE_READ")
            buf.extend(part)
        after = os.fstat(fd)
        require(
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
            "SOURCE_CHANGED",
        )
        require(hashlib.sha256(buf).hexdigest() == expected,
                "SOURCE_SHA_MISMATCH")
        return bytes(buf)
    finally:
        os.close(fd)


def strict_dir(path: Path, create: bool = False) -> None:
    if not os.path.lexists(path):
        require(create, "INSTALL_DIRECTORY_MISSING")
        path.mkdir(mode=0o755)
        os.chmod(path, 0o755)  # readable/executable by dedicated non-root signer
    st = os.lstat(path)
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0
            and not st.st_mode & 0o022 and st.st_mode & 0o005 == 0o005,
            "INSTALL_DIRECTORY_UNTRUSTED")


def install_exclusive(dest: Path, data: bytes) -> bool:
    if os.path.lexists(dest):
        st = os.lstat(dest)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == 0
                and st.st_nlink == 1 and not st.st_mode & 0o022
                and verified_bytes(dest, hashlib.sha256(data).hexdigest()) == data,
                "ALREADY_INSTALLED_SOURCE_DIFFERS")
        return False
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                 | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        os.fchmod(fd, 0o644)
        offset = 0
        while offset < len(data):
            written = os.write(fd, data[offset:])
            require(written > 0, "WRITE_FAILED")
            offset += written
        os.fsync(fd)
    finally:
        os.close(fd)
    require(verified_bytes(dest, hashlib.sha256(data).hexdigest()) == data,
            "INSTALL_READBACK_MISMATCH")
    return True


def signer_identity(apply: bool) -> None:
    try:
        u = pwd.getpwnam(ACCOUNT)
    except KeyError:
        if not apply:
            print("SIGNER_ACCOUNT=NEEDS_OWNER_INSTALL")
            return
        r = subprocess.run(
            ["/usr/sbin/useradd", "--system", "--create-home", "--home-dir",
             str(HOME), "--shell", "/usr/sbin/nologin", ACCOUNT],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=20, check=False,
        )
        require(r.returncode == 0, "SIGNER_ACCOUNT_CREATE_FAILED")
        u = pwd.getpwnam(ACCOUNT)
    require(u.pw_uid != 0 and Path(u.pw_dir) == HOME
            and u.pw_shell == "/usr/sbin/nologin",
            "SIGNER_IDENTITY_MISMATCH")
    if apply:
        st = os.lstat(HOME)
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == u.pw_uid
                and not st.st_mode & 0o022, "SIGNER_HOME_UNTRUSTED")
        os.chmod(HOME, 0o700)
    print("SIGNER_ACCOUNT=NONROOT_PINNED" if apply else "SIGNER_ACCOUNT=EXISTS")


def main(argv: list[str]) -> int:
    require(argv in ([], ["--apply", CONFIRM]), "ARGUMENTS_REJECTED")
    apply = bool(argv)
    require(os.geteuid() == 0 and socket.gethostname().split(".")[0].lower()
            == "kmj-elite", "ROOT_ELITE_ONLY")
    blobs = {parts: verified_bytes(src, pin)
             for parts, (src, pin) in PINNED.items()}
    print("THREE_REVIEWED_SOURCE_PINS=PASS")
    if not apply:
        signer_identity(False)
        print("ELITE_SIGNER_INSTALL=DRY_RUN_NO_CHANGES")
        return 0
    created: list[Path] = []
    try:
        strict_dir(Path("/usr/local/libexec"))
        strict_dir(TARGET, True)
        strict_dir(TARGET / "production", True)
        for parts, data in blobs.items():
            dest = TARGET.joinpath(*[x for x in parts if x])
            if install_exclusive(dest, data):
                created.append(dest)
        signer_identity(True)
        print("OWNER_PRIVATE_KEY=NOT_READ_OR_MOVED")
        print("GH_CREDENTIALS=NOT_READ_OR_MOVED")
        print("SIGNED_AUTO_DEPLOY_TIMER=UNCHANGED")
        print("PRODUCTION_SERVICES=UNCHANGED")
        print("ELITE_SIGNER_INSTALL=SOURCE_INSTALLED_NONROOT_ONLY")
        return 0
    except (Blocked, OSError, subprocess.TimeoutExpired):
        for dest in reversed(created):
            try:
                dest.unlink()
            except OSError:
                pass
        raise


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (Blocked, OSError, UnicodeError, subprocess.TimeoutExpired):
        print("ELITE_SIGNER_INSTALL=BLOCKED_NO_SIGN_OR_DEPLOY")
        sys.exit(2)
