#!/usr/bin/env python3
"""KMJ-elite owner-only: make the stage gateway config root-owned, group-readable.

Moves /etc/kmj-codebridge-stage from kmjcode:kmjcode 0700 and gateway.json from
kmjcode:kmjcode 0600 to root:kmjcode 0750 / 0640. The signed28 gateway accepts
that shape (src/config-file-mode.js) and the Supervisor config validator
requires it, so supervisor_config_validate stops reporting CONFIG_TRUST_INVALID.

The change is exactly two chown/chmod calls (file first, then directory) so the
service user never loses access. It never restarts anything, never reads or
prints the config contents, and never copies the real config (the readability
proof uses a throwaway dummy file). Any failed check restores the original
owner and mode. Modes: dry-run (default), --apply, --rollback.

Background: on 14 Nov an earlier one-pass script made this change while the
running runtime still required 0600 and the gateway failed to start. This
script refuses unless the live gateway runs the signed28 runtime, which is
proven (cwd and source commit) before anything is touched.
"""
import grp
import json
import os
import pathlib
import pwd
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile

UNIT = "kmj-codebridge-gateway-stage.service"
DIR = pathlib.Path("/etc/kmj-codebridge-stage")
FILE = DIR / "gateway.json"
SERVICE_USER = "kmjcode"
NODE = "/opt/kmj-codebridge-node/bin/node"
RELEASE_DIR = pathlib.Path("/opt/kmj-codebridge-stable/releases/0.3.2-f2a18a1feb0a")
RELEASE_SHA = "f2a18a1feb0aa9df8b888ae363e4cc96b769c83b"
LOCK = pathlib.Path("/run/lock/kmj-codebridge-config-owner.lock")
CONFIRM = "--confirm-root-group-config-owner-go"
BEFORE = (0o700, 0o600)  # dir, file (service-user owned)
AFTER = (0o750, 0o640)  # dir, file (root:kmjcode)


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


def cmd(*argv, timeout=25):
    try:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("COMMAND_UNAVAILABLE") from None
    return p.returncode, p.stdout.decode("utf-8", "replace").strip()


def show(prop):
    code, out = cmd("systemctl", "show", UNIT, "-P", prop, timeout=12)
    need(code == 0, "SYSTEMCTL_FAILED")
    return out


def ids():
    try:
        user = pwd.getpwnam(SERVICE_USER)
        group = grp.getgrnam(SERVICE_USER)
    except KeyError:
        raise Blocked("SERVICE_USER_OR_GROUP_MISSING") from None
    need(user.pw_uid > 0 and group.gr_gid > 0 and user.pw_gid == group.gr_gid,
         "SERVICE_USER_PRIMARY_GROUP_MISMATCH")
    return user.pw_uid, group.gr_gid


def require_root_parents(path):
    for parent in reversed(path.parents):
        st = os.lstat(parent)
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == 0
             and (st.st_mode & 0o022) == 0, "PARENT_UNTRUSTED")


def snapshot(expect_owner, expect_group, modes):
    """Return identity of dir and file; they must be exactly in the given state."""
    require_root_parents(DIR)
    d = os.lstat(DIR)
    need(stat.S_ISDIR(d.st_mode), "CONFIG_DIR_NOT_DIRECTORY")
    need(d.st_uid == expect_owner and d.st_gid == expect_group
         and stat.S_IMODE(d.st_mode) == modes[0], "CONFIG_DIR_STATE_UNEXPECTED")
    f = os.lstat(FILE)
    need(stat.S_ISREG(f.st_mode) and f.st_nlink == 1
         and 1 <= f.st_size <= 1048576, "CONFIG_FILE_NOT_REGULAR")
    need(f.st_uid == expect_owner and f.st_gid == expect_group
         and stat.S_IMODE(f.st_mode) == modes[1], "CONFIG_FILE_STATE_UNEXPECTED")
    return {"dir": (d.st_dev, d.st_ino), "file": (f.st_dev, f.st_ino)}


def prove_runtime():
    """The running gateway must be the signed28 runtime that accepts the new shape."""
    need(show("LoadState") == "loaded" and show("ActiveState") == "active"
         and show("NeedDaemonReload") == "no", "GATEWAY_NOT_READY")
    need(show("User") == SERVICE_USER, "GATEWAY_USER_DRIFT")
    need(show("WorkingDirectory") == str(RELEASE_DIR), "GATEWAY_NOT_SIGNED28")
    need(f"CODEBRIDGE_SOURCE_COMMIT={RELEASE_SHA}" in show("Environment"),
         "GATEWAY_COMMIT_ENV_MISMATCH")
    try:
        pid = int(show("MainPID"))
    except ValueError:
        raise Blocked("GATEWAY_PID_INVALID") from None
    need(pid > 1 and pathlib.Path(f"/proc/{pid}/cwd").resolve() == RELEASE_DIR,
         "GATEWAY_PROCESS_NOT_SIGNED28")
    mode_src = RELEASE_DIR / "src/config-file-mode.js"
    text = mode_src.read_text("utf-8") if mode_src.is_file() else ""
    need('serviceMode === "gateway" && stat.uid === 0' in text,
         "RUNTIME_DOES_NOT_ACCEPT_ROOT_OWNED_CONFIG")
    return pid


def node_mode_check(path):
    """Apply the runtime's own startup acceptance rule to a path as the service user."""
    script = (
        "import fs from 'node:fs';"
        f"import {{configModeAcceptable}} from {json.dumps(str(RELEASE_DIR / 'src/config-file-mode.js'))};"
        f"const s=fs.statSync({json.dumps(str(path))});"
        "if(!configModeAcceptable('gateway',s))process.exit(3);"
        f"fs.readFileSync({json.dumps(str(path))});"
    )
    code, _ = cmd("runuser", "-u", SERVICE_USER, "--", NODE,
                  "--input-type=module", "-e", script, timeout=20)
    return code == 0


def prove_readable_with_dummy(owner_gid):
    """Prove the exact target shape works for the service user, with a dummy file."""
    base = pathlib.Path(tempfile.mkdtemp(prefix="kmj-cfgproof-", dir="/run"))
    try:
        os.chown(base, 0, owner_gid)
        os.chmod(base, 0o750)
        dummy = base / "gateway.json"
        fd = os.open(dummy, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
        try:
            os.write(fd, b'{"proof":true}\n')
            os.fchown(fd, 0, owner_gid)
            os.fchmod(fd, AFTER[1])
        finally:
            os.close(fd)
        need(node_mode_check(dummy), "TARGET_SHAPE_NOT_STARTABLE_AS_SERVICE_USER")
        code, _ = cmd("runuser", "-u", "nobody", "--", "cat", str(dummy), timeout=10)
        need(code != 0, "TARGET_SHAPE_READABLE_BY_UNRELATED_USER")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def set_owner(path, uid, gid, mode, expected_inode, is_dir):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    if is_dir:
        flags |= os.O_DIRECTORY
    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
        need((st.st_dev, st.st_ino) == expected_inode, "CONFIG_INODE_CHANGED")
        os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def change(snap, to_owner, to_group, to_modes, order):
    """File first when relaxing, directory first when restoring."""
    for kind in order:
        target = DIR if kind == "dir" else FILE
        idx = 0 if kind == "dir" else 1
        set_owner(target, to_owner, to_group, to_modes[idx], snap[kind],
                  kind == "dir")


def validator_passes():
    script = (
        f"import {{readTrustedStageGatewayConfig}} from {json.dumps(str(RELEASE_DIR / 'src/stage-gateway-config.js'))};"
        "try{readTrustedStageGatewayConfig();}catch(e){process.exit(e?.code==='CONFIG_TRUST_INVALID'?4:5)}"
    )
    code, _ = cmd(NODE, "--input-type=module", "-e", script, timeout=20)
    return code == 0


def verify_after(pid_before, kmj_gid):
    need(node_mode_check(FILE), "CONFIG_NOT_STARTABLE_AS_SERVICE_USER")
    need(validator_passes(), "SUPERVISOR_VALIDATOR_STILL_REJECTS")
    need(show("ActiveState") == "active" and int(show("MainPID")) == pid_before,
         "GATEWAY_CHANGED_DURING_OWNER_CHANGE")


def run(argv):
    need(os.geteuid() == 0 and socket.gethostname().split(".")[0].lower()
         == "kmj-elite", "WRONG_ROOT_OR_HOST")
    need(argv in ([], ["--apply", CONFIRM], ["--rollback", CONFIRM]),
         "INVALID_ARGS")
    kmj_uid, kmj_gid = ids()
    rolling_back = argv[:1] == ["--rollback"]
    if rolling_back:
        snap = snapshot(0, kmj_gid, AFTER)
    else:
        snap = snapshot(kmj_uid, kmj_gid, BEFORE)
    pid = prove_runtime()
    print("GATEWAY_RUNTIME_SIGNED28=PASS")
    print("CONFIG_STATE_EXPECTED=PASS")
    if not rolling_back:
        prove_readable_with_dummy(kmj_gid)
        print("TARGET_SHAPE_STARTABLE_AS_SERVICE_USER=PASS")
        print("TARGET_SHAPE_DENIED_TO_UNRELATED_USER=PASS")
    if not argv:
        print("CONFIG_OWNER_CHANGE=DRY_RUN_UNCHANGED")
        return

    fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600)
    changed = False
    keep_lock = False
    prior = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}

    def interrupted(signum, frame):
        raise Blocked("INTERRUPTED")

    for s in prior:
        signal.signal(s, interrupted)
    try:
        if rolling_back:
            change(snap, kmj_uid, kmj_gid, BEFORE, ("dir", "file"))
            changed = True
            snapshot(kmj_uid, kmj_gid, BEFORE)
            need(show("ActiveState") == "active"
                 and int(show("MainPID")) == pid, "GATEWAY_CHANGED")
            print("CONFIG_OWNER_ROLLBACK=PASS")
        else:
            change(snap, 0, kmj_gid, AFTER, ("file", "dir"))
            changed = True
            snapshot(0, kmj_gid, AFTER)
            verify_after(pid, kmj_gid)
            print("CONFIG_OWNER_CHANGE=PASS")
            print("SUPERVISOR_CONFIG_VALIDATE_EXPECTED=VALID")
            print("GATEWAY_RESTART=NOT_PERFORMED")
    except BaseException as error:
        reason = error.args[0] if isinstance(error, Blocked) else "UNCLASSIFIED"
        print("CONFIG_OWNER_CHANGE=BLOCKED:" + str(reason))
        if changed and not rolling_back:
            try:
                restore = {"dir": os.lstat(DIR), "file": os.lstat(FILE)}
                inodes = {k: (v.st_dev, v.st_ino) for k, v in restore.items()}
                change(inodes, kmj_uid, kmj_gid, BEFORE, ("dir", "file"))
                snapshot(kmj_uid, kmj_gid, BEFORE)
                print("CONFIG_OWNER_AUTO_ROLLBACK=PASS")
            except BaseException:
                keep_lock = True
                print("CONFIG_OWNER_AUTO_ROLLBACK=FAILED_OWNER_REVIEW_REQUIRED")
                print("CONFIG_OWNER_LOCK=RETAINED_AFTER_FAILED_ROLLBACK")
                raise Blocked("ROLLBACK_FAILED") from None
        raise Blocked("OWNER_CHANGE_FAILED") from None
    finally:
        for s, handler in prior.items():
            signal.signal(s, handler)
        os.close(fd)
        if not keep_lock:
            try:
                os.unlink(LOCK)
            except OSError:
                pass


if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except (Blocked, OSError, ValueError, KeyError) as exc:
        safe = exc.args[0] if isinstance(exc, Blocked) else "UNCLASSIFIED"
        print("CONFIG_OWNER_RESULT=BLOCKED:" + (safe if re.fullmatch(
            r"[A-Z0-9_]{3,80}", str(safe)) else "UNCLASSIFIED"))
        raise SystemExit(2)
