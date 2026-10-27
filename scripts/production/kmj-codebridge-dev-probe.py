#!/usr/bin/python3
"""Offline, read-only CodeBridge development service probe. No model execution."""
import json
import os
import re
import subprocess
import sys

REPOSITORY = "/srv/kmj-codebridge-projects/kmj-main-platform"


def main():
    if os.geteuid() == 0 or len(sys.argv) != 1:
        print("KMJ_DEV_PROBE=DENIED", flush=True)
        return 2
    env = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_NO_REPLACE_OBJECTS": "1",
    }
    try:
        result = subprocess.run(
            [
                "/usr/bin/git", "-c", f"safe.directory={REPOSITORY}",
                "-C", REPOSITORY, "rev-parse", "--verify", "HEAD^{commit}",
            ],
            env=env, capture_output=True, text=True, timeout=10, check=True,
        )
        revision = result.stdout.strip()
        if re.fullmatch(r"[0-9a-f]{40}", revision) is None:
            raise ValueError("HEAD_INVALID")
    except (OSError, subprocess.SubprocessError, ValueError):
        print("KMJ_DEV_PROBE=SOURCE_UNAVAILABLE", flush=True)
        return 3
    print(json.dumps({"probe": "nonroot-git-head", "revision": revision}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
