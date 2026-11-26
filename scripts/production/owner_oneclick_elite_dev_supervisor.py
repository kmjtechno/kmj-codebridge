#!/usr/bin/env python3
"""One owner action: verify signed runtime, install/resume socket, stage binding.

Never restarts the agent, overwrites a unit, changes enrollment or uses another
project's socket. A separate job-drained activation and live RPC are mandatory.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import sys

RELEASES = Path("/opt/kmj-codebridge-stable/releases")
CURRENT = Path("/opt/kmj-codebridge-stable/current")
CONFIRM = "--confirm-elite-dev-supervisor-oneclick-owner-go"


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


def load_sibling(source, name):
    path = source / "scripts" / "production" / name
    info = os.lstat(path)
    need(stat.S_ISREG(info.st_mode) and info.st_uid == 0
         and info.st_nlink == 1 and not (info.st_mode & 0o022),
         "SIGNED_HELPER_UNTRUSTED")
    spec = importlib.util.spec_from_file_location(name.removesuffix(".py"), path)
    need(spec is not None and spec.loader is not None, "SIGNED_HELPER_UNAVAILABLE")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_exact_units(mod, spec):
    exists = [os.path.lexists(mod.UNIT_DIR / name) for name in spec]
    if not any(exists):
        return False
    need(all(exists), "PARTIAL_UNIT_INSTALL_REVIEW_REQUIRED")
    for name, expected in spec.items():
        path = mod.UNIT_DIR / name
        need(mod.root_file(path, 32768) == expected.encode("utf-8"),
             "EXISTING_UNIT_BYTES_MISMATCH")
        props = mod.run(["/usr/bin/systemctl", "show", name, "-p", "LoadState",
                         "-p", "FragmentPath", "-p", "DropInPaths",
                         "-p", "NeedDaemonReload"])
        fields = dict(line.split("=", 1) for line in props.splitlines() if "=" in line)
        need(fields.get("LoadState") == "loaded"
             and fields.get("FragmentPath") == str(path)
             and fields.get("DropInPaths") == ""
             and fields.get("NeedDaemonReload") == "no",
             "EXISTING_UNIT_EFFECTIVE_CONFIG_MISMATCH")
    return True


def socket_probe(mod):
    s = os.lstat(mod.SOCKET)
    user = pwd.getpwnam("kmjdev")
    parent = os.lstat(mod.SOCKET.parent)
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0
         and not (parent.st_mode & 0o022)
         and stat.S_ISSOCK(s.st_mode) and s.st_uid == user.pw_uid
         and s.st_gid == user.pw_gid and stat.S_IMODE(s.st_mode) == 0o600,
         "DEV_SOCKET_ACL_MISMATCH")
    mod.private_socket_probe()


def main(argv):
    need(argv in ([], ["--apply", CONFIRM]), "ONECLICK_ARGUMENTS_DENIED")
    need(os.geteuid() == 0 and socket.gethostname().split(".")[0].lower() == "kmj-elite",
         "ELITE_ROOT_REQUIRED")
    source = Path(__file__).resolve(strict=True).parents[2]
    need(source.parent == RELEASES and CURRENT.is_symlink()
         and CURRENT.resolve(strict=True) == source, "SIGNED_CURRENT_RUNTIME_REQUIRED")
    for parent in (source, *source.parents):
        st = os.lstat(parent)
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not (st.st_mode & 0o022),
             "ROOT_PARENT_UNTRUSTED")
    mod = load_sibling(source, "owner_install_elite_dev_supervisor.py")
    marker = json.loads(mod.root_file(source / ".codebridge-release.json", 4096))
    revision = marker.get("revision", "")
    verified, version = mod.signed_source(revision)
    need(verified == source, "SIGNED_RUNTIME_MISMATCH")
    binding = load_sibling(source, "owner_stage_elite_dev_supervisor_binding.py")
    before = binding.fixed_status(mod)
    digest = binding.verify_private_config(mod)
    mod.verify_enrollment(allow_existing=True)
    spec = mod.unit_texts(source, revision, version)
    existing = verify_exact_units(mod, spec)
    if not existing:
        mod.verify_enrollment()
    binding.trust_dropin_dir(mod)
    staged = os.path.lexists(binding.DROPIN)
    if staged:
        need(existing and mod.root_file(binding.DROPIN, 4096) == binding.TEXT
             and binding.binding_env_is_exact(before.get("Environment", "")),
             "EXISTING_BINDING_MISMATCH")
    else:
        need(not binding.binding_env_flags(before["Environment"]),
             "UNMANAGED_BINDING_PRESENT")
    print("ONECLICK_SIGNED_SCOPE=PASS")
    print("ONECLICK_EXISTING_UNITS=" + ("EXACT" if existing else "ABSENT"))
    if not argv:
        print("ONECLICK_SETUP=DRY_RUN_NO_CHANGES")
        return 0
    if not existing:
        mod.main(["--revision", revision, "--apply", mod.CONFIRM])
    else:
        state = mod.run(["/usr/bin/systemctl", "show", mod.SOCKET_UNIT,
                         "-p", "ActiveState", "--value"])
        need(state in ("active", "inactive"), "SOCKET_STATE_REVIEW_REQUIRED")
        if state == "inactive":
            need(not os.path.lexists(mod.SOCKET), "UNEXPECTED_SOCKET_COLLISION")
            try:
                mod.run(["/usr/bin/systemctl", "start", mod.SOCKET_UNIT])
                socket_probe(mod)
            except BaseException:
                mod.run(["/usr/bin/systemctl", "stop", mod.SOCKET_UNIT])
                raise
    socket_probe(mod)
    if not staged:
        binding.main(["--revision", revision, "--apply", binding.CONFIRM])
    after = binding.fixed_status(mod)
    need(binding.verify_private_config(mod) == digest
         and before["MainPID"] == after["MainPID"]
         and binding.binding_env_is_exact(after.get("Environment", "")),
         "AGENT_OR_BINDING_CHANGED_REVIEW_REQUIRED")
    print("ONECLICK_PRIVATE_SOCKET=READ_ONLY_RPC_PASS")
    print("ONECLICK_SETUP=STAGED_JOB_DRAINED_ACTIVATION_REQUIRED")
    print("AGENT_RESTART=NOT_ATTEMPTED")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:
        reason = str(error)
        safe = reason if type(error).__name__ == "Blocked" and re.fullmatch(
            r"[A-Z][A-Z0-9_]{3,90}", reason) else "REVIEW_REQUIRED"
        print("ONECLICK_BLOCKER=" + safe)
        print("ONECLICK_SETUP=BLOCKED_NO_LIVE_CREDIT")
        sys.exit(2)
