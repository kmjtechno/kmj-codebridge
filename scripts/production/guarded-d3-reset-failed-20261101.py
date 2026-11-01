#!/usr/bin/env python3
"""Root-only, exact-policy D3 lifecycle reconciliation; never changes Git ACLs.

Default is diagnostic. --apply may only reset the failed state of one fixed
non-root unit after all effective sandbox properties match a fixed allowlist.
No service start, enable, daemon-reload, recursive permission changes or deploy.
Prints bounded, sanitized key names only; operator must store a protected receipt.
"""
from __future__ import annotations

import hashlib
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
    # A matching on-disk SHA is not sufficient if systemd still has stale loaded bytes.
    "NeedDaemonReload": "no",
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
        # An inactive unit with a retained failed Result/exit code is not a
        # clean post-reset attestation. Never turn that into RESET_VERIFIED.
        stale = [key for key, expected in (("Result", "success"),
                                            ("ExecMainStatus", "0"))
                 if values[key] != expected]
        return ("UNEXPECTED_LIFECYCLE", stale, values) if stale else ("ALREADY_INACTIVE", [], values)
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
        if (st.st_uid != 0 or st.st_mode & 0o7022 or
            (not stat.S_ISREG(st.st_mode) if is_final else not stat.S_ISDIR(st.st_mode))):
            return False
        if is_final and st.st_nlink != 1:
            return False
    return True


# Pin both the complete systemd unit and its fixed helper before any root
# lifecycle mutation. Effective systemctl properties alone do not attest
# ExecStart, network restrictions or helper bytes.
EXPECTED_UNIT_SHA256 = "b851bb24cc5a846e3fc95a96893483f0dfd6540c91bc37d93a4f91aefd0ef53b"
HELPER_FILE = "/usr/local/libexec/kmj-codebridge-dev-probe.py"
EXPECTED_HELPER_SHA256 = "1191b0ebff956e64da17e52b6dd65b43afe3c80bdad21900a4c719d941da5be7"


def trusted_exact_content():
    # Root-owned parents, no symlinks, no special bits or group/world write.
    for path in ("/usr", "/usr/local", "/usr/local/libexec"):
        try:
            st = os.lstat(path)
        except OSError:
            return False
        if st.st_uid != 0 or st.st_mode & 0o7022 or not stat.S_ISDIR(st.st_mode):
            return False
    for path, limit, digest in (
        (UNIT_FILE, 8192, EXPECTED_UNIT_SHA256),
        (HELPER_FILE, 16384, EXPECTED_HELPER_SHA256),
    ):
        try:
            before = os.lstat(path)
            if (before.st_uid != 0 or before.st_mode & 0o7022 or
                not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                before.st_size < 1 or before.st_size > limit):
                return False
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                after = os.fstat(fd)
                if (after.st_dev != before.st_dev or after.st_ino != before.st_ino or
                    after.st_uid != 0 or after.st_mode & 0o7022 or
                    not stat.S_ISREG(after.st_mode) or after.st_nlink != 1 or
                    after.st_size != before.st_size):
                    return False
                payload = os.read(fd, limit + 1)
                if len(payload) != after.st_size or hashlib.sha256(payload).hexdigest() != digest:
                    return False
            finally:
                os.close(fd)
        except (OSError, ValueError):
            return False
    return True


def reconcile(*, apply=False, runner=subprocess.run, trusted=trusted_unit_path,
              content_trusted=trusted_exact_content):
    if not trusted():
        return "UNIT_PATH_UNTRUSTED", [], False
    state, keys, _ = inspect(runner)
    if state != "RESET_CANDIDATE" or not apply:
        return state, keys, False
    if not content_trusted():
        return "UNIT_CONTENT_UNTRUSTED", [], False
    # The first probe is not a mutation authorization: recheck fixed path,
    # exact bytes and effective properties immediately before reset-failed.
    # Any intervening drift must fail closed without invoking systemctl reset.
    if not trusted() or not content_trusted():
        return "PRE_RESET_TRUST_CHANGED", [], False
    before_reset, before_reset_keys, _ = inspect(runner)
    if before_reset != "RESET_CANDIDATE":
        return "PRE_RESET_STATE_CHANGED", before_reset_keys, False
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
