#!/usr/bin/env python3
"""One-time owner-only upgrade of the already installed Elite dispatcher.

No download, key access, signing, service change, or deployment.
Only exact reviewed predecessor bytes can become exact reviewed successor bytes.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys

ROOT = Path('/usr/local/libexec/kmj-fast-release')
TARGET = ROOT / 'elite_fast_release.py'
BACKUP = ROOT / 'elite_fast_release.py.pre-signer-pin-20261125'
WRAPPER = Path('/usr/local/libexec/kmj-codebridge-elite-signer/production/elite-onehost-release.mjs')
GATE = WRAPPER.parent.parent / 'release-ci-gate.mjs'
OLD = '321f1a8e299200027288f045c5d18e0f4b8c4e71a13e7eee154d97e5f991215a'
NEW = '21433d147dcd26ce16cfa7cb7dc05ada9a23e05a8e79258888e7287f2efc839b'
OLD_WRAPPER = 'cd3198b1f07ea5d24d4ac07c003a314fb76d7fdfea6bfa7c5cc4bf86dd2836c9'
NEW_WRAPPER = '9b291b59d5be85c1b050c89b8ec79b2ca8cb1ccdf59055717ecb54e068bcdc1e'
NEW_GATE = '74014d9ca667d73997f0286cabf294679906317916892784ce9d9e7da1338bea'
CONFIRM = '--confirm-owner-reviewed-fast-release-pin-upgrade'


def require(ok: bool, code: str) -> None:
    if not ok:
        raise ValueError(code)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked(path: Path) -> tuple[bytes, int]:
    for parent in path.parents:
        s = parent.lstat()
        require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and
                not s.st_mode & 0o022, 'UNTRUSTED_PARENT')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and
                s.st_nlink == 1 and not s.st_mode & 0o6022 and
                0 < s.st_size <= 200000, 'UNTRUSTED_FILE')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(200001)
        after = os.fstat(fd)
        require(len(raw) == s.st_size and
                (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
                'FILE_CHANGED')
        return raw, stat.S_IMODE(s.st_mode)
    finally:
        os.close(fd)


def successor(raw: bytes) -> bytes:
    require(digest(raw) == OLD, 'DISPATCHER_PREDECESSOR_SHA_MISMATCH')
    for a, b in (
        (OLD_WRAPPER, NEW_WRAPPER),
        ('# Independent immutable pin from CodeBridge root-only signer installation contract.',
         '# Reviewed 2026-11-23 signer CI-gate upgrade; never trust a runtime-supplied hash.'),
        ("NODE_CANDIDATES = ('/usr/local/bin/node', '/usr/bin/node', '/opt/node24/bin/node')",
         "NODE_CANDIDATES = ('/opt/kmj-codebridge-node/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/opt/node24/bin/node')"),
    ):
        require(raw.count(a.encode()) == 1, 'PATCH_ANCHOR_MISMATCH')
        raw = raw.replace(a.encode(), b.encode())
    require(digest(raw) == NEW, 'DISPATCHER_SUCCESSOR_SHA_MISMATCH')
    return raw


def exclusive(path: Path, raw: bytes, mode: int) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)
    require(checked(path) == (raw, mode), 'WRITE_READBACK_MISMATCH')


def sync_dir() -> None:
    fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def inspect() -> bool:
    result = subprocess.run(
        ['/usr/bin/python3', '-I', '-B', str(TARGET),
         '--project', 'codebridge', '--action', 'inspect'],
        stdin=subprocess.DEVNULL, capture_output=True, text=True,
        timeout=40, cwd='/', env={'PATH': '/usr/bin:/bin', 'LANG': 'C'},
        check=False,
    )
    return result.returncode == 0 and 'FAST_RELEASE=CODEBRIDGE_SIGNER_READY_NOT_SIGNED' in result.stdout


def main(args: list[str]) -> None:
    require(args in ([], ['--apply', CONFIRM]), 'ARGUMENTS_REJECTED')
    require(os.geteuid() == 0 and socket.gethostname().split('.')[0].lower() ==
            'kmj-elite', 'ROOT_ELITE_ONLY')
    require(digest(checked(WRAPPER)[0]) == NEW_WRAPPER and
            digest(checked(GATE)[0]) == NEW_GATE, 'REVIEWED_SIGNER_PAIR_MISMATCH')
    raw, mode = checked(TARGET)
    if digest(raw) == NEW:
        require(inspect(), 'ALREADY_UPDATED_SIGNER_INSPECT_BLOCKED')
        print('FAST_PIN_UPGRADE=ALREADY_CURRENT_INSPECT_PASS')
        return
    new = successor(raw)
    require(not os.path.lexists(BACKUP), 'BACKUP_ALREADY_EXISTS')
    print('FAST_PIN_UPGRADE=REVIEWED_PAIR_AND_PATCH_PASS')
    if not args:
        print('FAST_PIN_UPGRADE=DRY_RUN_UNCHANGED')
        return
    tmp = ROOT / '.elite_fast_release.py.pin-upgrade-20261125'
    restore = ROOT / '.elite_fast_release.py.pin-restore-20261125'
    require(not os.path.lexists(tmp) and not os.path.lexists(restore),
            'TEMP_OR_RECOVERY_PATH_PRESENT')
    exclusive(BACKUP, raw, 0o600)
    exclusive(tmp, new, mode)
    require(checked(TARGET) == (raw, mode), 'DISPATCHER_CHANGED_BEFORE_SWITCH')
    os.replace(tmp, TARGET)
    try:
        sync_dir()
        require(checked(TARGET) == (new, mode), 'SUCCESSOR_READBACK_MISMATCH')
        require(inspect(), 'SIGNER_INSPECT_BLOCKED')
    except Exception:
        exclusive(restore, raw, mode)
        os.replace(restore, TARGET)
        sync_dir()
        require(checked(TARGET) == (raw, mode), 'ROLLBACK_READBACK_MISMATCH')
        print('FAST_PIN_UPGRADE=ROLLED_BACK')
        raise
    print('FAST_PIN_UPGRADE=PASS_INSPECT_ONLY')
    print('SIGNING=NOT_STARTED')
    print('PRODUCTION_MUTATION=NONE')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print('FAST_PIN_UPGRADE=BLOCKED_REVIEW_REQUIRED')
        sys.exit(2)
