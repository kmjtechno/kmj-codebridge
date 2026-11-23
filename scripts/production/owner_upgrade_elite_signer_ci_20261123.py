#!/usr/bin/env python3
"""Owner-only SHA-pinned, rollback-capable Elite signer CI gate upgrade.

No private key/policy or credential access. No signing, timer, network or deploy.
Only root-staged reviewed gate and wrapper sources can be used.
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

STAGE = Path('/root/.kmj-codebridge-signer-gate-upgrade-20261123')
TARGET = Path('/usr/local/libexec/kmj-codebridge-elite-signer')
NODE = '/opt/kmj-codebridge-node/bin/node'
SIGNER = 'kmjsigner'
WRAPPER = TARGET / 'production' / 'elite-onehost-release.mjs'
GATE = TARGET / 'release-ci-gate.mjs'
LOCK = Path('/var/lib/kmj-codebridge-signer/.local/state/kmj-codebridge/auto-sign/single-flight.lock')
CONFIRM = '--confirm-owner-reviewed-ci-gate-upgrade'
FILES = (
    ('release-ci-gate.mjs', GATE,
     'da76cec89e2384a8c8c3126020bdded3b4955de53e8bfca6882fc446742436c1',
     '74014d9ca667d73997f0286cabf294679906317916892784ce9d9e7da1338bea'),
    ('elite-onehost-release.mjs', WRAPPER,
     'cd3198b1f07ea5d24d4ac07c003a314fb76d7fdfea6bfa7c5cc4bf86dd2836c9',
     '9b291b59d5be85c1b050c89b8ec79b2ca8cb1ccdf59055717ecb54e068bcdc1e'),
)

class Blocked(Exception):
    pass

def require(ok: bool, code: str) -> None:
    if not ok:
        raise Blocked(code)

def directory_guard(p: Path, uid: int, private: bool = False) -> None:
    s = p.lstat()
    require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
            and s.st_uid == uid and not s.st_mode & 0o022,
            'DIRECTORY_IDENTITY_UNTRUSTED')
    if private:
        require(s.st_mode & 0o077 == 0, 'PRIVATE_DIRECTORY_MODE_UNTRUSTED')

def verified_bytes(p: Path, uid: int, expected: str) -> bytes:
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        a = os.fstat(fd)
        require(stat.S_ISREG(a.st_mode) and a.st_uid == uid and a.st_nlink == 1
                and not a.st_mode & 0o022 and 100 < a.st_size < 100000,
                'FILE_IDENTITY_UNTRUSTED')
        raw = bytearray()
        while len(raw) < a.st_size:
            part = os.read(fd, a.st_size - len(raw))
            require(bool(part), 'SHORT_READ')
            raw.extend(part)
        b = os.fstat(fd)
        require((a.st_dev, a.st_ino, a.st_size, a.st_mtime_ns) ==
                (b.st_dev, b.st_ino, b.st_size, b.st_mtime_ns), 'SOURCE_CHANGED')
        require(hashlib.sha256(raw).hexdigest() == expected, 'SOURCE_SHA_MISMATCH')
        return bytes(raw)
    finally:
        os.close(fd)

def exclusive_write(p: Path, data: bytes, mode: int) -> None:
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        os.fchmod(fd, mode)
        offset = 0
        while offset < len(data):
            n = os.write(fd, data[offset:])
            require(n > 0, 'SHORT_WRITE')
            offset += n
        os.fsync(fd)
    finally:
        os.close(fd)

def inspect_signer() -> None:
    p = subprocess.run(
        ['/usr/sbin/runuser', '-u', SIGNER, '--', '/usr/bin/env',
         'HOME=/var/lib/kmj-codebridge-signer', 'USER=kmjsigner', 'LOGNAME=kmjsigner',
         'PATH=/usr/bin:/bin', NODE, str(WRAPPER), '--inspect'],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        encoding='utf8', timeout=25, check=False,
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
    )
    require(p.returncode == 0 and 'ELITE_ONEHOST_SIGNER=READY_FOR_OWNER_SIGN' in p.stdout
            and 'SIGNED_DEPLOY_TIMER=ACTIVE' in p.stdout,
            'SIGNER_POSTFLIGHT_INSPECT_BLOCKED')

def main(argv: list[str]) -> None:
    require(argv in ([], ['--apply', CONFIRM]), 'ARGUMENTS_REJECTED')
    apply = bool(argv)
    require(os.geteuid() == 0 and socket.gethostname().split('.')[0].lower() == 'kmj-elite',
            'ROOT_ELITE_ONLY')
    require(pwd.getpwnam(SIGNER).pw_uid != 0, 'NONROOT_SIGNER_REQUIRED')
    for d in [Path('/usr'), Path('/usr/local'), Path('/usr/local/libexec'),
              TARGET, TARGET / 'production']:
        directory_guard(d, 0)
    directory_guard(Path('/root'), 0, True)
    directory_guard(STAGE, 0, True)
    require(not os.path.lexists(LOCK), 'SIGNER_SINGLE_FLIGHT_LOCK_PRESENT')
    version = subprocess.run([NODE, '--version'], capture_output=True, text=True,
                             timeout=10, check=False)
    require(version.returncode == 0 and version.stdout.strip().startswith('v24.'),
            'PINNED_NODE24_UNAVAILABLE')
    require(all(not os.path.lexists(STAGE / ('backup-old-' + name))
                for name, *_ in FILES), 'RECOVERY_BACKUP_ALREADY_PRESENT')
    previous, incoming = {}, {}
    for name, installed, old_sha, new_sha in FILES:
        previous[name] = verified_bytes(installed, 0, old_sha)
        incoming[name] = verified_bytes(STAGE / name, 0, new_sha)
    print('OLD_INSTALLED_GATE_AND_WRAPPER=PINNED_PASS', flush=True)
    print('NEW_REVIEWED_GATE_AND_WRAPPER=PINNED_PASS', flush=True)
    if not apply:
        inspect_signer()
        print('ELITE_SIGNER_UPGRADE=INSPECT_READY_NO_CHANGES', flush=True)
        return

    temporary: list[Path] = []
    switched: list[str] = []
    try:
        for name, *_ in FILES:
            exclusive_write(STAGE / ('backup-old-' + name), previous[name], 0o600)
        for name, installed, _, new_sha in FILES:
            tmp = installed.parent / ('.' + name + '.owner-ci-upgrade-20261123')
            require(not os.path.lexists(tmp), 'TEMP_TARGET_ALREADY_PRESENT')
            exclusive_write(tmp, incoming[name], 0o644)
            temporary.append(tmp)
            verified_bytes(tmp, 0, new_sha)
        # Each rename is atomic. During the short two-file transition, the
        # wrapper SHA pin can only fail closed, never accept an unknown gate.
        for name, installed, _, _ in FILES:
            tmp = installed.parent / ('.' + name + '.owner-ci-upgrade-20261123')
            os.replace(tmp, installed)
            temporary.remove(tmp)
            switched.append(name)
        for name, installed, _, new_sha in FILES:
            verified_bytes(installed, 0, new_sha)
        inspect_signer()
        for directory in (TARGET, TARGET / 'production'):
            fd = os.open(directory, os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    except Exception:
        for name, installed, old_sha, _ in reversed(FILES):
            if name not in switched:
                continue
            restore = installed.parent / ('.' + name + '.owner-ci-restore-20261123')
            try:
                exclusive_write(restore, previous[name], 0o644)
                verified_bytes(restore, 0, old_sha)
                os.replace(restore, installed)
            except Exception:
                print('RECOVERY_REVIEW_REQUIRED=' + name, flush=True)
        raise
    finally:
        for p in temporary:
            try:
                p.unlink()
            except OSError:
                pass
    print('ELITE_SIGNER_UPGRADE=PASS_INSPECT_ONLY', flush=True)
    print('OWNER_PRIVATE_KEY=UNREAD_UNCHANGED', flush=True)
    print('SIGNED_RELEASE=NOT_STARTED', flush=True)
    print('PRODUCTION_DEPLOYMENT=NOT_ATTEMPTED', flush=True)

if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (Blocked, OSError, KeyError, ValueError, subprocess.TimeoutExpired) as exc:
        code = str(exc) if isinstance(exc, Blocked) else 'REVIEW_REQUIRED'
        print('ELITE_SIGNER_UPGRADE=BLOCKED:' + code, flush=True)
        sys.exit(2)
