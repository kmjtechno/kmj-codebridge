#!/usr/bin/env python3
"""Create-only KMJ-elite root installer for reviewed, SHA-pinned fast release.

No services/timers, keys, approvals, production pointers, repository checkouts
or deployments are modified. `--inspect` is read-only. `--apply` requires an
owner consent marker and fetches exact immutable reviewed commit source only.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import socket
import stat
import sys
from urllib.parse import urlparse
from urllib.request import Request, urlopen

CODEBRIDGE_REPO = 'kmjtechno/kmj-codebridge'
CODEBRIDGE_OPERATOR = 'scripts/production/elite_fast_release.py'
# Change together with the reviewed program source. NEVER accept a caller hash.
CODEBRIDGE_OPERATOR_SHA256 = '3203bf637223877d289cf63e59e67157d99c8a158fecea35762326a558e7586a'
MAIN_COMMIT = '7d8cc8d9e5c5a3d94bcaad520674c1e596730470'
MAIN_FILE = 'scripts/operations/owner-release-main-platform.sh'
MAIN_SHA256 = '325b24d32ebcf01b42994276a7beb550ed72c69cb044f8ffab03db6f1e218cec'
ROOT = Path('/usr/local/libexec/kmj-fast-release')
APP = ROOT / 'elite_fast_release.py'
MAIN = ROOT / 'owner-release-main-platform.sh'
WRAPPER = Path('/usr/local/sbin/kmj-fast-release')
WRAPPER_TEXT = ("#!/bin/sh\nexec /usr/bin/python3 -I -B "
                "/usr/local/libexec/kmj-fast-release/elite_fast_release.py \"$@\"\n")
SHA = re.compile(r'^[a-f0-9]{40}$')
CONFIRM = '--confirm-elite-root-reviewed-adapters-install'


class Blocked(Exception):
    pass


def require(value: bool, error: str) -> None:
    if not value:
        raise Blocked(error)


def root_elite() -> None:
    require(os.geteuid() == 0, 'ROOT_OWNER_REQUIRED')
    require(socket.gethostname().split('.')[0].lower() == 'kmj-elite', 'ELITE_HOST_REQUIRED')


def pinned_bytes(url: str, expected_sha: str, size_limit: int) -> bytes:
    require(url.startswith('https://raw.githubusercontent.com/kmjtechno/') and
            re.fullmatch(r'[0-9a-f]{64}', expected_sha) is not None,
            'PINNED_SOURCE_URI_REQUIRED')
    request = Request(url, headers={'User-Agent': 'KMJ-Owner-Reviewed-Fast-Install-1.0'})
    try:
        with urlopen(request, timeout=20) as response:
            target = urlparse(response.geturl())
            require(target.scheme == 'https' and target.hostname == 'raw.githubusercontent.com',
                    'SOURCE_REDIRECT_REJECTED')
            data = response.read(size_limit + 1)
    except Blocked:
        raise
    except (OSError, TimeoutError, ValueError):
        raise Blocked('PINNED_SOURCE_UNAVAILABLE') from None
    require(100 <= len(data) <= size_limit, 'PINNED_SOURCE_SIZE_INVALID')
    require(hashlib.sha256(data).hexdigest() == expected_sha, 'PINNED_SOURCE_SHA_MISMATCH')
    return data


def safe_dir(folder: Path, create: bool = False) -> None:
    if not folder.exists() and not folder.is_symlink():
        require(create, 'REQUIRED_DIRECTORY_MISSING')
        folder.mkdir(mode=0o755)
    st = folder.lstat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not (st.st_mode & 0o022),
            'ROOT_TRUST_DIR_UNSAFE')


def install_or_identical(target: Path, data: bytes, executable: bool = True) -> str:
    expected = hashlib.sha256(data).digest()
    if target.exists() or target.is_symlink():
        st = target.lstat()
        require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1 and
                not (st.st_mode & 0o022) and bool(st.st_mode & 0o100) == executable and
                st.st_size == len(data), 'EXISTING_FILE_UNTRUSTED')
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            old = b''
            while len(old) < st.st_size:
                part = os.read(fd, st.st_size - len(old))
                require(bool(part), 'EXISTING_FILE_SHORT_READ')
                old += part
        finally:
            os.close(fd)
        require(hashlib.sha256(old).digest() == expected, 'EXISTING_FILE_HASH_CONFLICT')
        return 'ALREADY_IDENTICAL'
    mode = 0o755 if executable else 0o644
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        os.fchmod(fd, mode)
        offset = 0
        while offset < len(data):
            count = os.write(fd, data[offset:])
            require(count > 0, 'INSTALL_SHORT_WRITE')
            offset += count
        os.fsync(fd)
    finally:
        os.close(fd)
    # Verify expected bytes immediately after create. No overwrite/retry on mismatch.
    st = target.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1 and
            not st.st_mode & 0o022 and st.st_size == len(data),
            'INSTALLED_FILE_IDENTITY_INVALID')
    with open(target, 'rb') as f:
        require(hashlib.sha256(f.read()).digest() == expected, 'INSTALLED_FILE_HASH_MISMATCH')
    parent_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    return 'CREATED'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Elite root create-only reviewed fast-release installer')
    parser.add_argument('--reviewed-codebridge-sha', required=True,
                        help='immutable protected CodeBridge merge SHA containing the reviewed helper')
    parser.add_argument('--apply', action='store_true', help='create only, no overwrite')
    parser.add_argument(CONFIRM, action='store_true', help='explicit owner consent for root installation')
    args = parser.parse_args(argv)
    root_elite()
    require(bool(SHA.fullmatch(args.reviewed_codebridge_sha)), 'REVIEWED_COMMIT_SHA_REQUIRED')
    require(args.apply == args.confirm_elite_root_reviewed_adapters_install,
            'OWNER_APPLY_CONFIRMATION_REQUIRED')
    ref = args.reviewed_codebridge_sha
    # Network bytes are never executed before SHA-256 and owner pin verification.
    code = pinned_bytes(f'https://raw.githubusercontent.com/{CODEBRIDGE_REPO}/{ref}/{CODEBRIDGE_OPERATOR}',
                        CODEBRIDGE_OPERATOR_SHA256, 120000)
    main = pinned_bytes(f'https://raw.githubusercontent.com/kmjtechno/kmj-main-platform/{MAIN_COMMIT}/{MAIN_FILE}',
                        MAIN_SHA256, 120000)
    print('FAST_INSTALL_PINNED_SOURCES=PASS')
    if not args.apply:
        print('FAST_INSTALL=DRY_RUN_UNCHANGED')
        return 0
    for folder in (Path('/usr'), Path('/usr/local'), Path('/usr/local/libexec'),
                   Path('/usr/local/sbin')):
        safe_dir(folder)
    safe_dir(ROOT, create=True)
    for name, target, payload in [('dispatcher', APP, code), ('main-platform-adapter', MAIN, main),
                                  ('one-command-cli', WRAPPER, WRAPPER_TEXT.encode('ascii'))]:
        state = install_or_identical(target, payload)
        print(f'FAST_INSTALL_{name.upper().replace("-", "_")}={state}')
    print('FAST_INSTALL=CREATE_ONLY_PASS')
    print('SIGNING=NOT_STARTED')
    print('PRODUCTION_MUTATION=NONE')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (Blocked, OSError, ValueError, TypeError) as error:
        code = str(error) if isinstance(error, Blocked) else 'LOCAL_INSTALL_EXCEPTION'
        print('FAST_INSTALL=BLOCKED:' + code)
        raise SystemExit(2)
