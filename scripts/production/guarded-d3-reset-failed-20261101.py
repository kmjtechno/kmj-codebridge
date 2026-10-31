#!/usr/bin/env python3
"""Root-only, exact-policy D3 lifecycle reconciliation; never changes Git ACLs.

Default is diagnostic. --apply may only reset the failed state of one fixed
non-root unit after all effective sandbox properties match a fixed allowlist.
No service start, enable, daemon-reload, recursive permission changes or deploy.
Prints bounded, sanitized key names only; operator must store a protected receipt.
"""
from __future__ import annotations

import os
import re
import socket
import stat
import subprocess
import sys

UNIT = "kmj-codebridge-development-ci.service"
UNIT_FILE = "/etc/systemd/system/" + UNIT
EXPECTED = {
    "LoadState": "loaded",
    "FragmentPath": UNIT_FILE,
    "DropInPaths": "",
    "User": "kmjdevci",
    "Group": "kmjdevci",
    "NoNewPrivileges": "yes",
    "ProtectSystem": "strict",
    "ProtectHome": "yes",
    "PrivateTmp": "yes",
    "PrivateDevices": "yes",
    "PrivateNetwork": "yes",
    "CapabilityBoundingSet": "",
    "AmbientCapabilities": "",
    "EnvironmentFiles": "",
    "ReadWritePaths": "/var/lib/kmj-codebridge-development-ci",
}
DYNAMIC = ("ActiveState", "Result", "ExecMainStatus")
FIELDS = tuple(EXPECTED) + DYNAMIC
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "LANG": "C"}
SAFE_VALUE = re.compile(r"[\x20-\x7e]{0,512}\Z")


def parse_properties(raw):
    if not isinstance(raw, str) or len(raw) > 8192 or "\r" in raw or "\x00" in raw:
        return None
    lines = raw.removesuffix("\n").split("\n")
    if len(lines) != len(FIELDS):
        return None
    values = {}
    for line in lines:
        if "=" not in line:
            return None
        key, value = line.split("=", 1)
        if key not in FIELDS or key in values or not SAFE_VALUE.fullmatch(value):
            return None
        values[key] = value
    return values if set(values) == set(FIELDS) else None


def run_fixed(args, runner=subprocess.run):
    try:
        result = runner(args, capture_output=True, text=True, timeout=10,
                        stdin=subprocess.DEVNULL, env=ENV, check=False)
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        return None
    if len(result.stdout) > 8192 or len(result.stderr) > 8192:
        return None
    return result


def inspect(runner=subprocess.run):
    args = ["/usr/bin/systemctl", "show", UNIT, "--no-pager"]
    for key in FIELDS:
        args.extend(["-p", key])
    response = run_fixed(args, runner)
    if response is None or response.returncode != 0:
        return "SHOW_FAILED", [], None
    values = parse_properties(response.stdout)
    if values is None:
        return "MALFORMED", [], None
    mismatches = [key for key in EXPECTED if values[key] != EXPECTED[key]]
    if mismatches:
        return "POLICY_DRIFT", mismatches, values
    if values["ActiveState"] == "inactive":
        return "ALREADY_INACTIVE", [], values
    if (values["ActiveState"] == "failed" and
        values["Result"] == "exit-code" and
        values["ExecMainStatus"] == "3"):
        return "RESET_CANDIDATE", ["ActiveState"], values
    return "UNEXPECTED_LIFECYCLE", ["ActiveState", "Result", "ExecMainStatus"], values


def trusted_unit_path(lstat=os.lstat):
    for path in ("/", "/etc", "/etc/systemd", "/etc/systemd/system", UNIT_FILE):
        try:
            st = lstat(path)
        except OSError:
            return False
        is_final = path == UNIT_FILE
        if (st.st_uid != 0 or st.st_mode & 0o022 or
            (not stat.S_ISREG(st.st_mode) if is_final else not stat.S_ISDIR(st.st_mode))):
            return False
        if is_final and st.st_nlink != 1:
            return False
    return True


def reconcile(*, apply=False, runner=subprocess.run, trusted=trusted_unit_path):
    if not trusted():
        return "UNIT_PATH_UNTRUSTED", [], False
    state, keys, _ = inspect(runner)
    if state != "RESET_CANDIDATE" or not apply:
        return state, keys, False
    result = run_fixed(["/usr/bin/systemctl", "reset-failed", UNIT], runner)
    if result is None or result.returncode != 0:
        return "RESET_FAILED", keys, True
    after, after_keys, _ = inspect(runner)
    if after != "ALREADY_INACTIVE":
        return "POSTCHECK_FAILED", after_keys, True
    return "RESET_VERIFIED", [], True


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if (args not in ([], ["--diagnose"], ["--apply"]) or os.geteuid() != 0 or
        socket.gethostname().split(".")[0].lower() != "kmj-elite"):
        print("D3_LIFECYCLE_RESULT=BLOCKED_HOST_ROOT_OR_ARGS")
        return 2
    state, keys, mutated = reconcile(apply=args == ["--apply"])
    print("D3_LIFECYCLE_SCHEMA=kmj.d3.lifecycle.v1")
    print("D3_LIFECYCLE_RESULT=" + state)
    print("D3_MISMATCH_KEYS=" + (",".join(keys) if keys else "NONE"))
    print("D3_RESET_ATTEMPTED=" + ("YES" if mutated else "NO"))
    print("D3_GIT_ACL_CHANGED=NO")
    print("D3_WORKER_STARTED=NO")
    print("D3_PRODUCTION_DEPLOYED=NO")
    return 0 if state in ("ALREADY_INACTIVE", "RESET_VERIFIED") else 3


if __name__ == "__main__":
    raise SystemExit(main())
