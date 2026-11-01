#!/usr/bin/env python3
"""Read-only D3 blocker evidence for fixed kmj-elite CodeBridge nonroot probe.

Never dumps systemctl property values, Git metadata, key material or job output.
Never repairs ownership/ACLs, starts units, or runs project code.
The live CodeBridge Supervisor still independently controls any privileged start.
"""
from __future__ import annotations
import os
import re
import stat
import socket
import subprocess
import sys

UNIT = "kmj-codebridge-development-ci.service"
PROJECT = "/srv/kmj-codebridge-projects/kmj-main-platform"
ACCOUNT = "kmjdevci"
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C",
       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
       "GIT_NO_LAZY_FETCH": "1", "GIT_NO_REPLACE_OBJECTS": "1",
       "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}
EXPECTED = {
    "LoadState": "loaded", "ActiveState": "inactive",
    "FragmentPath": "/etc/systemd/system/kmj-codebridge-development-ci.service",
    "DropInPaths": "", "NeedDaemonReload": "no", "User": ACCOUNT, "Group": ACCOUNT,
    "NoNewPrivileges": "yes", "ProtectSystem": "strict",
    "ProtectHome": "yes", "PrivateTmp": "yes", "PrivateDevices": "yes",
    "PrivateNetwork": "yes", "CapabilityBoundingSet": "", "AmbientCapabilities": "",
    "EnvironmentFiles": "", "ReadWritePaths": "/var/lib/kmj-codebridge-development-ci",
}
ALLOWED_KEYS = frozenset(EXPECTED)
SHA40 = re.compile(r"[a-f0-9]{40}\Z")


def fixed_run(args, timeout=10):
    """Argument-only subprocess; bounded output, no caller-selected argv."""
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                           env=ENV, check=False, stdin=subprocess.DEVNULL)
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        return None
    if len(p.stdout) > 8192 or len(p.stderr) > 8192:
        return None
    return p


def parse_systemd(raw):
    if not isinstance(raw, str) or len(raw) > 8192 or "\r" in raw or "\x00" in raw:
        return None
    lines = raw.removesuffix("\n").split("\n")
    if len(lines) != len(EXPECTED):
        return None
    result = {}
    for line in lines:
        if "=" not in line:
            return None
        key, value = line.split("=", 1)
        if key not in ALLOWED_KEYS or key in result or len(value) > 512:
            return None
        result[key] = value
    return result if result.keys() == ALLOWED_KEYS else None


def probe_systemd(run=fixed_run):
    args = ["/usr/bin/systemctl", "show", UNIT, "--no-pager"]
    for key in EXPECTED:
        args.extend(["-p", key])
    result = run(args)
    if result is None or result.returncode != 0:
        return "READ_FAILED", []
    values = parse_systemd(result.stdout)
    if values is None:
        return "MALFORMED", []
    mismatches = [key for key in EXPECTED if values[key] != EXPECTED[key]]
    lifecycle = [k for k in mismatches if k == "ActiveState"]
    policy = [k for k in mismatches if k != "ActiveState"]
    if policy:
        return "POLICY_DRIFT", policy + lifecycle
    if lifecycle:
        return "FAILED_OR_ACTIVE_UNIT", lifecycle
    return "MATCH", []


def classify_error(p):
    if p is None:
        return "UNAVAILABLE"
    if p.returncode == 0:
        return "PASS"
    # stderr is never printed or returned. The classes are advisory only.
    s = (p.stdout + p.stderr).lower()
    if "permission denied" in s or "unable to access" in s or "not permitted" in s:
        return "ACCESS_DENIED"
    if "dubious ownership" in s:
        return "OWNER_MISMATCH"
    if "not a git repository" in s or "not found" in s:
        return "REPOSITORY_UNAVAILABLE"
    return "FAILED_UNCLASSIFIED"


def probe_git(run=fixed_run):
    # Never whitelist checkout ownership: Git must report dubious ownership
    # rather than presenting a policy-bypassed read as healthy D3 evidence.
    prefix = ["/usr/sbin/runuser", "-u", ACCOUNT, "--", "/usr/bin/git",
              "-C", PROJECT]
    head = run(prefix + ["rev-parse", "--verify", "HEAD"])
    status = classify_error(head)
    if status != "PASS" or head is None or not SHA40.fullmatch(head.stdout.strip()):
        return {"HEAD": "INVALID_OUTPUT" if status == "PASS" else status,
                "OBJECT": "NOT_CHECKED", "MAIN_REF": "NOT_CHECKED"}
    sha = head.stdout.strip()
    obj = run(prefix + ["cat-file", "-e", sha + "^{commit}"])
    ref = run(prefix + ["show-ref", "--verify", "--quiet", "refs/heads/main"])
    return {"HEAD": "PASS", "OBJECT": classify_error(obj), "MAIN_REF": classify_error(ref)}


PACK_DIR = PROJECT + "/.git/objects/pack"
PACK_NAME = re.compile(r"pack-[a-f0-9]{40,64}\.(?:pack|idx|rev|bitmap|promisor|mtimes|keep)\Z")


def probe_pack_access(run=fixed_run, lstat=os.lstat, scandir=os.scandir):
    """Advisory, bounded, read-only kmjdevci access to fixed Git pack files.

    Never emits filenames, Git objects, path contents or credentials.
    This is NOT a permission repair or evidence of an AI worker starting.
    """
    directories = ("/srv", "/srv/kmj-codebridge-projects", PROJECT,
                   PROJECT + "/.git", PROJECT + "/.git/objects", PACK_DIR)
    try:
        for path in directories:
            info = lstat(path)
            if not stat.S_ISDIR(info.st_mode):
                return "UNTRUSTED_PATH"
        files = []
        with scandir(PACK_DIR) as entries:
            # Bound *all* directory entries, not just recognized pack names.
            # Otherwise arbitrary ignored names permit an unbounded root scan.
            entry_count = 0
            for entry in entries:
                entry_count += 1
                if entry_count > 128:
                    return "TOO_MANY_ENTRIES"
                if not PACK_NAME.fullmatch(entry.name):
                    continue
                path = PACK_DIR + "/" + entry.name
                info = lstat(path)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    return "UNTRUSTED_ENTRY"
                files.append(path)
    except FileNotFoundError:
        return "MISSING"
    except (OSError, ValueError, TypeError):
        return "UNAVAILABLE"
    if not files:
        return "NO_PACK_FILES"
    for path in files:
        result = run(["/usr/sbin/runuser", "-u", ACCOUNT, "--",
                      "/usr/bin/test", "-r", path])
        if result is None:
            return "UNAVAILABLE"
        if result.returncode != 0:
            return "SOME_UNREADABLE"
    return "PASS"



def probe_main_ref_storage(run=fixed_run, lstat=os.lstat):
    """Bounded per-inode evidence for fixed loose/packed main-ref storage.

    A readable packed-refs file does NOT prove that it contains main.
    Only git show-ref may establish the ref; this check diagnoses DAC/path
    failures without opening or printing any Git metadata.
    """
    root_dirs = ("/srv", "/srv/kmj-codebridge-projects", PROJECT,
                 PROJECT + "/.git")
    loose_dirs = (PROJECT + "/.git/refs", PROJECT + "/.git/refs/heads")
    candidates = (PROJECT + "/.git/packed-refs",
                  PROJECT + "/.git/refs/heads/main")
    try:
        for path in root_dirs:
            if not stat.S_ISDIR(lstat(path).st_mode):
                return "UNTRUSTED_PATH"
        readable_paths = []
        for index, path in enumerate(candidates):
            if index == 1:
                missing_dir = False
                for parent in loose_dirs:
                    try:
                        info = lstat(parent)
                    except FileNotFoundError:
                        missing_dir = True
                        break
                    if not stat.S_ISDIR(info.st_mode):
                        return "UNTRUSTED_PATH"
                if missing_dir:
                    continue
            try:
                info = lstat(path)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                return "UNTRUSTED_ENTRY"
            readable_paths.append(path)
    except FileNotFoundError:
        return "MISSING_PROJECT"
    except (OSError, ValueError, TypeError):
        return "UNAVAILABLE"
    if not readable_paths:
        return "NO_REF_STORAGE"
    for path in readable_paths:
        result = run(["/usr/sbin/runuser", "-u", ACCOUNT, "--",
                      "/usr/bin/test", "-r", path])
        if result is None:
            return "UNAVAILABLE"
        if result.returncode != 0:
            return "SOME_UNREADABLE"
    return "PASS"


def inspect(run=fixed_run):
    policy, keys = probe_systemd(run)
    git = probe_git(run)
    pack_access = probe_pack_access(run)
    main_ref_storage = probe_main_ref_storage(run)
    return {
        "D3_DIAGNOSTIC_SCHEMA": "kmj.d3.readonly.v1",
        "SYSTEMD_STATUS": policy,
        "SYSTEMD_MISMATCH_KEYS": ",".join(keys) if keys else "NONE",
        "GIT_HEAD": git["HEAD"], "GIT_OBJECT": git["OBJECT"],
        "GIT_MAIN_REF": git["MAIN_REF"],
        "GIT_PACK_ACCESS": pack_access,
        "GIT_MAIN_REF_STORAGE": main_ref_storage,
        "ROOT_OR_REPO_MUTATED": "NO", "WORKER_STARTED": "NO",
        "PRODUCTION_DEPLOYED": "NO",
    }


def main():
    if sys.argv[1:] or os.geteuid() != 0 or socket.gethostname().split(".")[0].lower() != "kmj-elite":
        print("D3_DIAGNOSTIC=BLOCKED_HOST_ROOT_OR_ARGS")
        return 2
    data = inspect()
    for key, value in data.items():
        print(key + "=" + value)
    print("D3_DIAGNOSTIC=READ_ONLY_COMPLETE")
    # A successful Git show-ref does not override independently unreadable\n    # packed/loose main-ref storage. A diagnostic exit 0 requires both.\n    return 0 if data["SYSTEMD_STATUS"] == "MATCH" and all(data[k] == "PASS" for k in ("GIT_HEAD", "GIT_OBJECT", "GIT_MAIN_REF")) and data["GIT_PACK_ACCESS"] in ("PASS", "NO_PACK_FILES") and data["GIT_MAIN_REF_STORAGE"] == "PASS" else 3


if __name__ == "__main__":
    raise SystemExit(main())
