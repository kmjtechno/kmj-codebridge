#!/usr/bin/env python3
"""Elite-only source-attested, root-managed dev Supervisor agent flag drop-in.

Dry-run by default. Applies ONLY a fixed create-only systemd drop-in after
the original owner Ed25519 signed archive and private Supervisor RPC pass.
NEVER restarts the agent, edits enrollment tokens, or touches other services.
This only STAGES the flag for a separately job-drained owner start.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import sys
import tempfile

REV = "scripts/production/owner_install_elite_dev_supervisor.py"
THIS = "scripts/production/owner_stage_elite_dev_supervisor_binding.py"
CONFIRM = "--confirm-elite-dev-supervisor-root-binding-owner-go"
UNIT = "kmj-codebridge-dev.service"
SOCKET_UNIT = "kmj-codebridge-dev-supervisor.socket"
ROOT = Path("/etc/systemd/system")
DIRECTORY = ROOT / "kmj-codebridge-dev.service.d"
DROPIN = DIRECTORY / "80-kmj-signed-dev-supervisor-binding.conf"
TEXT = (b"[Unit]\n"
        b"Requires=kmj-codebridge-dev-supervisor.socket\n"
        b"After=kmj-codebridge-dev-supervisor.socket\n"
        b"\n[Service]\n"
        b"Environment=KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND=1\n")
FLAG = "KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND=1"


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


def release_guard(revision):
    """Import only the fixed signed sibling, then verify the entire archive."""
    import re
    need(type(revision) is str and re.fullmatch(r"[a-f0-9]{40}", revision),
         "EXACT_SIGNED_REVISION_REQUIRED")
    here = Path(__file__).absolute()
    sibling = here.with_name("owner_install_elite_dev_supervisor.py")
    for p in (here, sibling):
        s = os.lstat(p)
        need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1
             and not (s.st_mode & 0o022), "ROOT_SIGNED_SOURCE_REQUIRED")
    spec = importlib.util.spec_from_file_location("_kmj_elite_signed_install", sibling)
    need(spec is not None and spec.loader is not None, "SIGNED_MODULE_MISSING")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    source, version = mod.signed_source(revision)
    need(here == source / THIS and sibling == source / REV,
         "OWNER_BINDING_MUST_RUN_FROM_SIGNED_RELEASE")
    need(DROPIN.parent == DIRECTORY and DROPIN.name ==
         "80-kmj-signed-dev-supervisor-binding.conf",
         "ROOT_DROPIN_SCOPE_MISMATCH")
    return mod, source


def fixed_status(mod):
    props = mod.run([
        "/usr/bin/systemctl", "show", UNIT,
        "-p", "LoadState", "-p", "ActiveState",
        "-p", "User", "-p", "Group",
        "-p", "MainPID", "-p", "NRestarts",
        "-p", "NeedDaemonReload", "-p", "FragmentPath",
        "-p", "Environment",
    ])
    d = dict(line.split("=", 1) for line in props.splitlines()
             if line.count("=") == 1)
    need(d.get("LoadState") == "loaded"
         and d.get("ActiveState") == "active"
         and d.get("User") == "kmjdev"
         and d.get("Group") == "kmjdev"
         and d.get("FragmentPath") == str(ROOT / UNIT)
         and d.get("NeedDaemonReload") == "no"
         and d.get("MainPID", "").isdigit()
         and int(d["MainPID"]) > 1
         and d.get("NRestarts", "").isdigit(),
         "DEV_AGENT_EFFECTIVE_IDENTITY_INVALID")
    return d


def verify_private_config(mod):
    uid = pwd.getpwnam("kmjdev").pw_uid
    parent = os.lstat(mod.AGENT_CONFIG.parent)
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == uid
         and (parent.st_mode & 0o077) == 0,
         "DEV_CONFIG_DIRECTORY_UNTRUSTED")
    fd = os.open(mod.AGENT_CONFIG, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == uid
             and st.st_nlink == 1 and (st.st_mode & 0o077) == 0
             and 0 < st.st_size < 65536, "DEV_CONFIG_UNTRUSTED")
        raw = os.read(fd, st.st_size)
        need(len(raw) == st.st_size, "DEV_CONFIG_READ_INCOMPLETE")
        end = os.fstat(fd)
        need((st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
             == (end.st_dev, end.st_ino, end.st_size, end.st_mtime_ns, end.st_ctime_ns),
             "DEV_CONFIG_CHANGED_DURING_READ")
        d = json.loads(raw)
    finally:
        os.close(fd)
    need(type(d) is dict and d.get("id") == "kmj-codebridge-elite"
         and type(d.get("projects")) is list and len(d["projects"]) == 1
         and d["projects"][0].get("id") == "kmj-codebridge"
         and d.get("supervisorSocket") in (None, str(mod.SOCKET))
         and not d.get("supervisorPipe") and not d.get("supervisorTokenFile"),
         "DEV_ENROLLMENT_BINDING_SCOPE_MISMATCH")
    return hashlib.sha256(raw).hexdigest()


def trust_dropin_dir(mod, create=False):
    mod.root_parents(DIRECTORY)
    if create and not os.path.lexists(DIRECTORY):
        os.mkdir(DIRECTORY, 0o755)
    if os.path.lexists(DIRECTORY):
        s = os.lstat(DIRECTORY)
        need(stat.S_ISDIR(s.st_mode) and s.st_uid == 0
             and not (s.st_mode & 0o022), "DROPIN_DIR_UNTRUSTED")


def write_once(mod, data=TEXT):
    """Atomic create-only publish; never replace a preexisting owner unit."""
    trust_dropin_dir(mod)
    need(not os.path.lexists(DROPIN), "DROPIN_ALREADY_PRESENT")
    fd, stage = tempfile.mkstemp(prefix=".kmj-bind-staged-", dir=str(DIRECTORY))
    published = False
    try:
        st = os.fstat(fd)
        need(st.st_uid == 0 and stat.S_ISREG(st.st_mode) and st.st_nlink == 1,
             "ROOT_STAGE_INODE_UNTRUSTED")
        os.fchmod(fd, 0o644)
        written = 0
        while written < len(data):
            n = os.write(fd, data[written:])
            need(n > 0, "DROPIN_SHORT_WRITE")
            written += n
        os.fsync(fd)
        need(os.fstat(fd).st_size == len(data), "DROPIN_LENGTH_INVALID")
        try:
            os.link(stage, DROPIN, follow_symlinks=False)
        except FileExistsError:
            raise Blocked("DROPIN_ALREADY_PRESENT") from None
        published = True
        dirfd = os.open(DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    except BaseException:
        if published:
            current = os.lstat(DROPIN)
            original = os.fstat(fd)
            need((current.st_dev, current.st_ino) ==
                 (original.st_dev, original.st_ino),
                 "DROPIN_ROLLBACK_INODE_MISMATCH")
            os.unlink(DROPIN)
        raise
    finally:
        os.close(fd)
        if os.path.lexists(stage):
            os.unlink(stage)
    return (st.st_dev, st.st_ino)


def remove_owned(mod, expected_identity):
    """Rollback only the exact inode created by this invocation."""
    current = os.lstat(DROPIN)
    need((current.st_dev, current.st_ino) == expected_identity,
         "DROPIN_ROLLBACK_INODE_MISMATCH")
    raw = mod.root_file(DROPIN, 4096)
    need(raw == TEXT, "DROPIN_ROLLBACK_BYTES_MISMATCH")
    os.unlink(DROPIN)
    mod.run(["/usr/bin/systemctl", "daemon-reload"])


def binding_env_is_exact(text):
    if type(text) is not str:
        return False
    items = text.split()
    prefix = "KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND="
    flags = [x for x in items if x.startswith(prefix)]
    return flags == [FLAG]


def main(argv):
    need(type(argv) is list and (len(argv) == 2 and argv[0] == "--revision"
         or len(argv) == 4 and argv[0] == "--revision"
         and argv[2:] == ["--apply", CONFIRM]), "OWNER_BINDING_ARGS_DENIED")
    need(os.geteuid() == 0 and socket.gethostname().split(".")[0].lower() == "kmj-elite",
         "ROOT_ELITE_ONLY")
    mod, source = release_guard(argv[1])
    before = fixed_status(mod)
    before_digest = verify_private_config(mod)
    need(not any(item.startswith("KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND=")
                 for item in before.get("Environment", "").split()),
         "BIND_FLAG_ALREADY_PRESENT")
    trust_dropin_dir(mod)
    need(not os.path.lexists(DROPIN), "DROPIN_ALREADY_PRESENT")
    need(mod.run(["/usr/bin/systemctl", "is-active", SOCKET_UNIT]) == "active",
         "PRIVATE_SOCKET_UNIT_NOT_ACTIVE")
    st = os.lstat(mod.SOCKET)
    account = pwd.getpwnam("kmjdev")
    need(stat.S_ISSOCK(st.st_mode) and st.st_uid == account.pw_uid
         and st.st_gid == account.pw_gid
         and stat.S_IMODE(st.st_mode) == 0o600,
         "PRIVATE_SOCKET_ACL_INVALID")
    mod.private_socket_probe()
    if len(argv) == 2:
        print("DEV_BINDING_ROOT_PREFLIGHT=PASS_NO_CHANGES")
        print("DEV_BINDING_AGENT_RESTART=NOT_ATTEMPTED")
        return 0
    created_identity = None
    try:
        trust_dropin_dir(mod, create=True)
        created_identity = write_once(mod)
        mod.run(["/usr/bin/systemctl", "daemon-reload"])
        after = fixed_status(mod)
        need(binding_env_is_exact(after.get("Environment", ""))
             and (after["MainPID"], after["NRestarts"]) ==
             (before["MainPID"], before["NRestarts"]),
             "DEV_AGENT_RESTART_OR_DROPIN_MISMATCH")
        need(verify_private_config(mod) == before_digest,
             "DEV_CONFIG_MUTATED")
        print("DEV_BINDING_ROOT_DROPIN=STAGED_NO_AGENT_RESTART")
        print("DEV_AGENT_BINDING_LIVE_RPC=NOT_YET_VERIFIED")
        return 0
    except BaseException:
        if created_identity is not None:
            try:
                remove_owned(mod, created_identity)
            except BaseException:
                print("DEV_BINDING_ROLLBACK=FAILED_MANUAL_RECOVERY")
                raise
        raise


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (Blocked, OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        print("DEV_BINDING_ROOT_DROPIN=BLOCKED_NO_LIVE_CREDIT")
        sys.exit(2)
