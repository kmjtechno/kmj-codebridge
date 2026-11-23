#!/usr/bin/env python3
"""KMJ Elite root-only, reviewed-adapter fast release dispatcher.

Release admission is NOT a generic root shell. Only two exact, pinned adapters
are admitted in V1. Every other project fails closed pending a separate
reviewed adapter. No user supplied paths, commands, URLs or repositories.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path('/usr/local/libexec/kmj-fast-release')
MAIN_HELPER = ROOT / 'owner-release-main-platform.sh'
# Reviewed owner helper at kmj-main-platform 7d8cc8d9e5c5...
MAIN_HELPER_SHA256 = '325b24d32ebcf01b42994276a7beb550ed72c69cb044f8ffab03db6f1e218cec'
SIGNER = Path('/usr/local/libexec/kmj-codebridge-elite-signer/production/elite-onehost-release.mjs')
# Independent immutable pin from CodeBridge root-only signer installation contract.
SIGNER_SHA256 = 'cd3198b1f07ea5d24d4ac07c003a314fb76d7fdfea6bfa7c5cc4bf86dd2836c9'
RUNUSER = '/usr/sbin/runuser'
SELF = ROOT / 'elite_fast_release.py'
SHA = re.compile(r'^[0-9a-f]{40}$')
CONFIRM = 'OWNER_APPROVES_PINNED_FAST_RELEASE'
GITHUB_API = 'https://api.github.com'
ROOT_RELEASES = Path('/home/kmjprod/releases')
CURRENT = Path('/home/kmjprod/current')
NODE_CANDIDATES = ('/usr/local/bin/node', '/usr/bin/node', '/opt/node24/bin/node')

# Every supported project must have reviewed, fixed source and exact adapters.
# A root CLI caller cannot register a new repository or select an executable.
PROJECTS = {
    'main-platform': {
        'repo': 'kmjtechno/kmj-main-platform',
        'required_workflows': ('Verify Foundation', 'Staging Promotion Gate', 'Server Infrastructure CI'),
        'actions': ('inspect', 'prepare', 'release', 'post-activation'),
    },
    'codebridge': {
        'repo': 'kmjtechno/kmj-codebridge',
        'required_workflows': ('CodeBridge CI',),
        'actions': ('inspect', 'sign'),
    },
}
DISABLED_PROJECTS = {
    'cloudos': 'CLOUDOS_RELEASE_ADAPTER_NOT_REVIEWED',
    'omnidesk': 'WINDOWS_SIGNED_RELEASE_ADAPTER_NOT_REVIEWED',
    'calibration': 'WINDOWS_SIGNED_RELEASE_ADAPTER_NOT_REVIEWED',
    'cinecore': 'WINDOWS_SIGNED_RELEASE_ADAPTER_NOT_REVIEWED',
}


class Blocked(Exception):
    pass


def require(ok: bool, code: str) -> None:
    if not ok:
        raise Blocked(code)


def require_elite_root() -> None:
    require(os.geteuid() == 0, 'ELITE_ROOT_REQUIRED')
    require(socket.gethostname().split('.')[0].lower() == 'kmj-elite', 'WRONG_HOST')


def sha_input(raw: str | None) -> str:
    require(isinstance(raw, str) and bool(SHA.fullmatch(raw)), 'EXACT_MAIN_SHA_REQUIRED')
    return raw


def trusted_regular_file(path: Path, expected_sha: str, max_bytes: int = 200000) -> None:
    # All trusted code must be root-owned and not replaceable by unprivileged users.
    require(path.is_absolute(), 'REVIEWED_PATH_REQUIRED')
    for parent in (Path('/usr'), Path('/usr/local'), Path('/usr/local/libexec'), path.parent.parent, path.parent):
        st = parent.lstat()
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not (st.st_mode & 0o022), 'TRUSTED_PARENT_INVALID')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1 and
                not (before.st_mode & 0o022) and 0 < before.st_size <= max_bytes,
                'PINNED_FILE_IDENTITY_INVALID')
        data = bytearray()
        while len(data) < before.st_size:
            chunk = os.read(fd, before.st_size - len(data))
            require(bool(chunk), 'PINNED_FILE_SHORT_READ')
            data.extend(chunk)
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
                'PINNED_FILE_CHANGED')
        require(hashlib.sha256(data).hexdigest() == expected_sha, 'PINNED_FILE_SHA_MISMATCH')
    finally:
        os.close(fd)


def github_json(uri_path: str) -> dict:
    require(uri_path.startswith('/repos/kmjtechno/') and not ('..' in uri_path), 'UNTRUSTED_GITHUB_API_PATH')
    req = Request(GITHUB_API + uri_path, headers={
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'KMJ-Elite-Fast-Release-1.0',
    })
    try:
        with urlopen(req, timeout=12) as res:
            require(urlparse(res.geturl()).scheme == 'https' and
                    urlparse(res.geturl()).hostname == 'api.github.com',
                    'GITHUB_API_REDIRECT_REJECTED')
            raw = res.read(1048577)
            require(len(raw) <= 1048576, 'GITHUB_API_OVERSIZED')
            obj = json.loads(raw)
            require(isinstance(obj, dict), 'GITHUB_API_INVALID_JSON')
            return obj
    except Blocked:
        raise
    except (OSError, TimeoutError, ValueError, TypeError):
        raise Blocked('GITHUB_API_UNAVAILABLE') from None


def verify_exact_main_ci(repo: str, sha: str, required: tuple[str, ...]) -> dict[str, str]:
    # Guard a fixed repository, never caller-supplied repository or branch.
    require(repo in tuple(p['repo'] for p in PROJECTS.values()), 'REPOSITORY_NOT_ALLOWLISTED')
    sha_input(sha)
    main = github_json(f'/repos/{repo}/git/ref/heads/main')
    require(main.get('object', {}).get('sha') == sha, 'MAIN_HEAD_CHANGED_OR_SHA_NOT_MAIN')
    runs = github_json(f'/repos/{repo}/actions/runs?branch=main&head_sha={sha}&per_page=100')
    rows = runs.get('workflow_runs')
    require(isinstance(rows, list) and 0 < len(rows) < 100, 'EXACT_HEAD_WORKFLOW_RUNS_UNVERIFIED')
    latest: dict[str, dict] = {}
    for x in rows:
        require(isinstance(x, dict), 'WORKFLOW_RUN_INVALID')
        if x.get('head_sha') != sha or x.get('head_branch') != 'main':
            continue
        name = x.get('name')
        if not isinstance(name, str) or not isinstance(x.get('id'), int):
            raise Blocked('WORKFLOW_RUN_IDENTITY_INVALID')
        if name not in latest or x['id'] > latest[name]['id']:
            latest[name] = x
    require(all(name in latest for name in required), 'REQUIRED_CI_CHECK_ABSENT')
    require(all(x.get('status') == 'completed' and x.get('conclusion') == 'success'
                for x in latest.values()), 'EXACT_HEAD_CI_NOT_ALL_GREEN')
    # Check main HEAD again: avoid admitting a stale SHA after validation.
    final = github_json(f'/repos/{repo}/git/ref/heads/main')
    require(final.get('object', {}).get('sha') == sha, 'MAIN_MOVED_DURING_ADMISSION')
    return {name: 'PASS' for name in required}


def current_main_platform() -> str:
    try:
        candidate = CURRENT.resolve(strict=True)
        root = ROOT_RELEASES.resolve(strict=True)
    except OSError:
        raise Blocked('LIVE_RELEASE_POINTER_UNAVAILABLE') from None
    require(candidate.parent == root and candidate.name.startswith('platform-'),
            'LIVE_RELEASE_POINTER_UNTRUSTED')
    return candidate.name


def trusted_node24_binary(candidate: str) -> Path | None:
    # Never exec Node from a writable ancestor: the process runs under the
    # privileged owner's Ed25519 signer identity after dropping root.
    try:
        resolved = Path(candidate).resolve(strict=True)
        for entry in (resolved, *resolved.parents):
            st = entry.lstat()
            if st.st_uid != 0 or st.st_mode & 0o022:
                return None
            if entry == resolved:
                if not (stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and
                        st.st_mode & 0o111 and not st.st_mode & 0o6000 and
                        10000 < st.st_size < 200000000):
                    return None
            elif not stat.S_ISDIR(st.st_mode):
                return None
        return resolved
    except OSError:
        return None


def verified_node24() -> str:
    for candidate in NODE_CANDIDATES:
        try:
            resolved = trusted_node24_binary(candidate)
            if resolved is None:
                continue
            result = subprocess.run([str(resolved), '--version'], capture_output=True, text=True,
                                    timeout=4, check=False, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
            if result.returncode == 0 and re.fullmatch(r'v24\.\d+\.\d+\n?', result.stdout):
                return str(resolved)
        except (OSError, subprocess.TimeoutExpired):
            continue
    raise Blocked('PINNED_ROOT_OWNED_NODE24_NOT_FOUND')


def invoke_fixed(argv: list[str], timeout: int, env: dict[str, str]) -> str:
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                                cwd='/', env=env, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked('PINNED_EXECUTION_UNAVAILABLE_OR_TIMEOUT') from None
    # No raw stdout/stderr: pinned programs can emit sensitive diagnostics.
    require(result.returncode == 0, 'PINNED_OPERATOR_REFUSED_OR_FAILED')
    return result.stdout[-16384:]


def run_main_platform(action: str, sha: str) -> None:
    trusted_regular_file(MAIN_HELPER, MAIN_HELPER_SHA256)
    if action in ('prepare', 'release'):
        verify_exact_main_ci(PROJECTS['main-platform']['repo'], sha,
                             PROJECTS['main-platform']['required_workflows'])
        if current_main_platform() == 'platform-' + sha[:12]:
            print('FAST_RELEASE=ALREADY_LIVE_UNCHANGED')
            return
    elif action == 'post-activation':
        # CI main may have moved *after* a reviewed activation. A post-activation
        # migration must use the exact live SHA, not the newest GitHub main.
        require(current_main_platform() == 'platform-' + sha[:12],
                'POST_ACTIVATION_SHA_NOT_LIVE')
    args = ['/bin/bash', str(MAIN_HELPER)]
    if action == 'prepare':
        args.extend(['--prepare-only', sha])
    elif action == 'post-activation':
        args.extend(['--post-activation', sha])
    else:
        args.append(sha)
    receipt = invoke_fixed(args, 4500, {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C', 'LC_ALL': 'C'})
    markers = {
        'prepare': 'APPROVAL_DONE_PREPARE_ONLY_ACTIVATE_THEN_RUN_POST_ACTIVATION',
        'release': 'CHAIN_EXIT=0',
        'post-activation': 'CHAIN_EXIT=0',
    }
    if markers[action] not in receipt or 'BLOCKED' in receipt:
        raise Blocked('OWNER_RELEASE_RECEIPT_UNVERIFIED')
    print('FAST_RELEASE=OWNER_STEP_COMPLETE_ACTIVATION_AND_LIVE_READBACK_REQUIRED')


def run_codebridge(action: str, sha: str | None) -> None:
    trusted_regular_file(SIGNER, SIGNER_SHA256)
    node = verified_node24()
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
    args = [RUNUSER, '-u', 'kmjsigner', '--', node, str(SIGNER)]
    # Inspect first: it must say ready, never infer readiness from timer alone.
    inspect = invoke_fixed(args + ['--inspect'], 25, env)
    require('ELITE_ONEHOST_SIGNER=READY_FOR_OWNER_SIGN' in inspect and
            'SIGNED_DEPLOY_TIMER=ACTIVE' in inspect,
            'OWNER_SIGNER_NOT_ATTESTED')
    if action == 'inspect':
        print('FAST_RELEASE=CODEBRIDGE_SIGNER_READY_NOT_SIGNED')
        return
    verify_exact_main_ci(PROJECTS['codebridge']['repo'], sha_input(sha),
                         PROJECTS['codebridge']['required_workflows'])
    result = invoke_fixed(args + ['--sign-once'], 650, env)
    require('ELITE_OWNER_SIGN=REVIEW_GATED' in result,
            'OWNER_SIGNED_PR_RECEIPT_UNVERIFIED')
    print('FAST_RELEASE=SIGNED_PR_REVIEW_REQUIRED_NOT_LIVE')


def require_installed_self() -> None:
    require(Path(__file__).resolve() == SELF and SELF.is_file(), 'REVIEWED_ROOT_INSTALL_REQUIRED')
    selfstat = SELF.lstat()
    require(stat.S_ISREG(selfstat.st_mode) and selfstat.st_uid == 0 and
            selfstat.st_nlink == 1 and not selfstat.st_mode & 0o022,
            'REVIEWED_ROOT_INSTALL_UNTRUSTED')
    for parent in SELF.parents:
        st = parent.lstat()
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022,
                'REVIEWED_ROOT_PARENT_UNTRUSTED')


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='KMJ Elite protected, project-adapter fast release')
    parser.add_argument('--project', help='fixed project ID (catalog to list)')
    parser.add_argument('--action', choices=('catalog', 'inspect', 'prepare', 'release', 'post-activation', 'sign'),
                        default='catalog')
    parser.add_argument('--sha', help='exact 40-character GitHub main commit SHA')
    parser.add_argument('--confirm', help='explicit owner confirmation for mutations')
    args = parser.parse_args(argv)
    require_elite_root()
    require_installed_self()
    if args.action == 'catalog':
        require(args.project is None and args.sha is None and args.confirm is None,
                'CATALOG_ARGUMENTS_NOT_ALLOWED')
        for name, spec in PROJECTS.items():
            print(f'{name}=REVIEWED_ADAPTER actions={",".join(spec["actions"])}')
        for name, reason in DISABLED_PROJECTS.items():
            print(f'{name}=BLOCKED:{reason}')
        print('FAST_RELEASE=CATALOG_READ_ONLY')
        return 0
    require(args.project in PROJECTS, 'PROJECT_ADAPTER_NOT_APPROVED')
    require(args.action in PROJECTS[args.project]['actions'], 'ACTION_NOT_APPROVED_FOR_PROJECT')
    require((args.action in ('prepare', 'release', 'post-activation', 'sign')) == (args.confirm == CONFIRM),
            'EXPLICIT_OWNER_APPROVAL_REQUIRED_OR_UNEXPECTED')
    if args.action == 'inspect':
        require(args.sha is None, 'INSPECT_SHA_NOT_ALLOWED')
        if args.project == 'main-platform':
            trusted_regular_file(MAIN_HELPER, MAIN_HELPER_SHA256)
            print('MAIN_PLATFORM_LIVE=' + current_main_platform())
            print('FAST_RELEASE=MAIN_PLATFORM_ADAPTER_READY_READ_ONLY')
        else:
            run_codebridge('inspect', None)
        return 0
    sha = sha_input(args.sha)
    if args.project == 'main-platform':
        run_main_platform(args.action, sha)
    else:
        run_codebridge('sign', sha)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (Blocked, OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        code = str(error) if isinstance(error, Blocked) else 'LOCAL_GUARD_EXCEPTION'
        print('FAST_RELEASE=BLOCKED:' + code)
        raise SystemExit(2)
