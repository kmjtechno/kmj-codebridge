#!/usr/bin/python3
"""Offline, fixed-SHA, non-root CodeBridge probe of an isolated source checkout.

No hooks, network, credentials, untrusted shared Git object stores, or changes
to existing production repositories. This is a probe, not an AI code runner.
"""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

REPOSITORY = Path("/var/lib/kmj-codebridge-development-ci/source")
STATE = REPOSITORY.parent
EXPECTED_SHA = "a9796a25a2801cd303a69f5ad468aa9a704e5fff"


def safe_directory(path, expected_uid, private=False):
    try:
        metadata = os.lstat(path)
        return (
            stat.S_ISDIR(metadata.st_mode)
            and metadata.st_uid == expected_uid
            and (metadata.st_mode & 0o022) == 0
            and (not private or (metadata.st_mode & 0o077) == 0)
        )
    except OSError:
        return False


def git(args, env):
    try:
        outcome = subprocess.run(
            [
                "/usr/bin/git",
                "-c", "protocol.file.allow=never",
                "-c", "protocol.ext.allow=never",
                "-c", "core.hooksPath=/dev/null",
                "-C", str(REPOSITORY),
                *args,
            ],
            env=env, capture_output=True, text=True,
            stdin=subprocess.DEVNULL, timeout=10, check=False,
        )
        if outcome.returncode or len(outcome.stdout) > 4096:
            return None
        return outcome.stdout.strip()
    except (OSError, UnicodeError, subprocess.SubprocessError):
        return None


def main():
    uid = os.geteuid()
    if os.geteuid() == 0 or len(sys.argv) != 1:
        print("KMJ_DEV_PROBE=DENIED", flush=True)
        return 2
    if not (
        safe_directory(STATE, uid, private=True)
        and safe_directory(REPOSITORY, uid, private=True)
        and safe_directory(REPOSITORY / ".git", uid)
        and (REPOSITORY / ".git" / "shallow").is_file()
        and not (REPOSITORY / ".git" / "shallow").is_symlink()
    ):
        print("KMJ_DEV_PROBE=ISOLATED_SOURCE_UNTRUSTED", flush=True)
        return 3
    env = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": "/nonexistent",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "/bin/false",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_LFS_SKIP_SMUDGE": "1",
    }
    revision = git(["rev-parse", "--verify", "HEAD^{commit}"], env)
    object_type = git(["cat-file", "-t", EXPECTED_SHA], env)
    count = git(["rev-list", "--count", "HEAD"], env)
    status = git(["status", "--porcelain=v1", "--untracked-files=all"], env)
    if not (
        revision == EXPECTED_SHA and object_type == "commit"
        and count == "1" and status == ""
        and re.fullmatch(r"[0-9a-f]{40}", revision or "")
    ):
        print("KMJ_DEV_PROBE=PINNED_SOURCE_UNAVAILABLE", flush=True)
        return 3
    print(json.dumps({
        "probe": "nonroot-isolated-shallow-git",
        "revision": EXPECTED_SHA,
        "history": "one-commit",
    }, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
