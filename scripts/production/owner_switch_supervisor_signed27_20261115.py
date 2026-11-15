#!/usr/bin/env python3
"""KMJ-elite owner-only: point the root Supervisor at signed stable27.

The gateway cutover and the signed updater do not move the Supervisor unit.
It still starts the seq21 release (dc14877375a5), which does not know the
Main Platform backup/health operations added in #932/#935, so those tools
answer SUPERVISOR_OPERATION_NOT_ALLOWED.

This script only adds one lexicographically later ExecStart drop-in. It never
restarts, stops or kills anything: the Supervisor is socket-activated and
exits after 60 s idle, so the next request starts the new path. It never
touches keys, the gateway, agents, the updater, Nginx, stable/current, the
socket unit or an existing drop-in. The seq21 drop-in stays as the rollback
authority.

Modes: (none) dry-run | --apply | --rollback
"""
import os
import pathlib
import re
import stat
import subprocess
import sys
import time

UNIT = "kmj-codebridge-supervisor.service"
UNIT_PATH = pathlib.Path("/etc/systemd/system/kmj-codebridge-supervisor.service")
DIR = pathlib.Path("/etc/systemd/system/kmj-codebridge-supervisor.service.d")
OLD_CONF = DIR / "zzzzz-kmj-dev-attestation-release.conf"
NEW_CONF = DIR / "zzzzzz-kmj-signed27-supervisor.conf"
OLD_DIR = pathlib.Path("/opt/kmj-codebridge-stable/releases/0.3.2-dc14877375a5")
NEW_DIR = pathlib.Path("/opt/kmj-codebridge-stable/releases/0.3.2-40655678db7f")
STABLE_CURRENT = pathlib.Path("/opt/kmj-codebridge-stable/current")
NODE = "/opt/kmj-codebridge-node/bin/node"
LOCK = pathlib.Path("/run/lock/kmj-codebridge-supervisor-signed27.lock")
NEW_OPERATIONS = (
    "main_platform_local_backup_evidence",
    "main_platform_backup_inventory",
    "main_platform_health_unit_receipt",
)
NEW_MODULES = (
    "src/cli.js",
    "src/supervisor.js",
    "src/main-platform-local-backup-evidence.js",
    "src/main-platform-backup-inventory.js",
)
MAX_TREE_ENTRIES = 200000


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


def cmd(*argv, timeout=25):
    try:
        p = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=timeout, check=False,
                           env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("COMMAND_UNAVAILABLE") from None
    need(p.returncode == 0, "COMMAND_FAILED")
    need(len(p.stdout) <= 1024 * 1024, "COMMAND_OUTPUT_TOO_LARGE")
    return p.stdout.decode("utf-8", "replace").strip()


def show(prop):
    return cmd("systemctl", "show", UNIT, "-P", prop, timeout=12)


def content(release_dir):
    return ("[Service]\n"
            "ExecStart=\n"
            f"ExecStart={NODE} {release_dir}/src/cli.js supervisor\n").encode()


def effective_argv():
    # systemd prints: { path=... ; argv[]=<argv> ; ignore_errors=no ; ... }
    found = re.findall(r"argv\[\]=(.*?) ;", show("ExecStart"))
    need(len(found) == 1, "SUPERVISOR_EXECSTART_NOT_SINGLE")
    return found[0]


def expected_argv(release_dir):
    return f"{NODE} {release_dir}/src/cli.js supervisor"


def require_root_parent(path):
    for ancestor in [pathlib.Path("/"), *reversed(path.parent.parents), path.parent]:
        try:
            st = os.lstat(ancestor)
        except OSError:
            raise Blocked("OWNER_PARENT_MISSING") from None
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and (st.st_mode & 0o022) == 0,
             "OWNER_PARENT_UNTRUSTED")


def root_file(path, max_size=16384):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise Blocked("OWNER_FILE_UNAVAILABLE") from None
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1
             and 1 <= st.st_size <= max_size and (st.st_mode & 0o022) == 0,
             "UNTRUSTED_OWNER_FILE")
        data = os.read(fd, max_size + 1)
        need(len(data) == st.st_size, "OWNER_FILE_RACE")
        return data
    finally:
        os.close(fd)


def validate_release_tree():
    """Root will execute this tree: nothing in it may be writable by non-root."""
    need(STABLE_CURRENT.is_symlink()
         and STABLE_CURRENT.resolve(strict=True) == NEW_DIR,
         "SIGNED27_CURRENT_POINTER_MISMATCH")
    require_root_parent(NEW_DIR / "x")
    count = 0
    for root, dirs, files in os.walk(NEW_DIR, followlinks=False):
        for name in [".", *dirs, *files]:
            count += 1
            need(count <= MAX_TREE_ENTRIES, "SIGNED27_TREE_TOO_LARGE")
            st = os.lstat(os.path.join(root, name))
            need(st.st_uid == 0, "SIGNED27_TREE_NOT_ROOT_OWNED")
            if stat.S_ISLNK(st.st_mode):
                target = os.path.realpath(os.path.join(root, name))
                need(target == str(NEW_DIR) or target.startswith(str(NEW_DIR) + "/"),
                     "SIGNED27_TREE_SYMLINK_ESCAPES")
                continue
            need(stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode),
                 "SIGNED27_TREE_SPECIAL_FILE")
            need((st.st_mode & 0o022) == 0, "SIGNED27_TREE_WRITABLE_BY_NON_ROOT")
    for relative in NEW_MODULES:
        file = NEW_DIR / relative
        need(file.is_file() and not file.is_symlink() and file.stat().st_size > 0,
             "SIGNED27_RUNTIME_FILE_MISSING")
        cmd(NODE, "--check", str(file), timeout=30)
    source = (NEW_DIR / "src/supervisor.js").read_text("utf-8")
    for operation in NEW_OPERATIONS:
        need(f'request.op === "{operation}"' in source,
             "SIGNED27_SUPERVISOR_OPERATION_MISSING")
    st = os.stat(NODE)
    need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and (st.st_mode & 0o022) == 0
         and os.access(NODE, os.X_OK), "NODE24_UNAVAILABLE")


def validate_unit():
    need(show("LoadState") == "loaded" and show("FragmentPath") == str(UNIT_PATH),
         "UNEXPECTED_SYSTEMD_UNIT")
    need(show("NeedDaemonReload") == "no", "DAEMON_RELOAD_PENDING")
    need(show("ActiveState") in ("active", "inactive"), "SUPERVISOR_UNIT_NOT_HEALTHY")
    require_root_parent(NEW_CONF)
    st = os.lstat(DIR)
    need(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and (st.st_mode & 0o022) == 0,
         "DROPIN_DIR_UNTRUSTED")
    names = sorted(n for n in os.listdir(DIR) if n.endswith(".conf"))
    return names


def wait_idle():
    """Never stop the unit; just report whether the old process has gone."""
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        if show("ActiveState") == "inactive":
            return True
        time.sleep(3)
    return False


def daemon_reload():
    cmd("systemctl", "daemon-reload", timeout=60)


def remove_only_ours():
    try:
        if root_file(NEW_CONF) == content(NEW_DIR):
            os.unlink(NEW_CONF)
            return True
    except (Blocked, OSError):
        pass
    return False


def apply():
    names = validate_unit()
    need(NEW_CONF.name not in names, "SIGNED27_SUPERVISOR_OVERRIDE_ALREADY_PRESENT")
    need(names and names[-1] == OLD_CONF.name and NEW_CONF.name > names[-1],
         "DROPIN_ORDER_UNEXPECTED")
    need(root_file(OLD_CONF) == content(OLD_DIR), "SEQ21_SUPERVISOR_OVERRIDE_DRIFT")
    need(effective_argv() == expected_argv(OLD_DIR), "SUPERVISOR_NOT_ON_SEQ21")
    validate_release_tree()
    print("SIGNED27_SUPERVISOR_PREFLIGHT=PASS")
    if sys.argv[1:] != ["--apply"]:
        print("SIGNED27_SUPERVISOR=DRY_RUN_UNCHANGED")
        return
    data = content(NEW_DIR)
    temp = DIR / (".kmj-signed27-supervisor.%d.tmp" % os.getpid())
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        os.write(fd, data)
        os.fchmod(fd, 0o644)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.link(temp, NEW_CONF)  # fails if the name appeared meanwhile
    finally:
        os.unlink(temp)
    try:
        daemon_reload()
        need(effective_argv() == expected_argv(NEW_DIR),
             "SIGNED27_SUPERVISOR_NOT_EFFECTIVE")
    except Blocked as reason:
        removed = remove_only_ours()
        try:
            daemon_reload()
            restored = effective_argv() == expected_argv(OLD_DIR)
        except Blocked:
            restored = False
        print("SIGNED27_SUPERVISOR=BLOCKED:" + str(reason))
        print("SUPERVISOR_AUTO_ROLLBACK="
              + ("PASS" if removed and restored else "FAILED_OWNER_REVIEW_REQUIRED"))
        raise
    print("SIGNED27_SUPERVISOR=APPLIED")
    print("SUPERVISOR_RESTARTED=NO")
    print("SUPERVISOR_OLD_PROCESS_EXITED="
          + ("YES" if wait_idle() else "NOT_YET_WAIT_FOR_60S_IDLE"))
    print("NEXT=VERIFY_THE_THREE_TOOLS_FROM_CODEBRIDGE")


def rollback():
    validate_unit()
    need(os.path.lexists(NEW_CONF), "SIGNED27_SUPERVISOR_OVERRIDE_ABSENT")
    need(root_file(NEW_CONF) == content(NEW_DIR), "SIGNED27_SUPERVISOR_OVERRIDE_DRIFT")
    need(root_file(OLD_CONF) == content(OLD_DIR), "SEQ21_SUPERVISOR_OVERRIDE_DRIFT")
    os.unlink(NEW_CONF)
    daemon_reload()
    need(effective_argv() == expected_argv(OLD_DIR), "SUPERVISOR_ROLLBACK_NOT_EFFECTIVE")
    print("SIGNED27_SUPERVISOR=ROLLED_BACK")
    print("SUPERVISOR_RESTARTED=NO")
    print("SUPERVISOR_OLD_PROCESS_EXITED="
          + ("YES" if wait_idle() else "NOT_YET_WAIT_FOR_60S_IDLE"))


def run():
    need(sys.platform.startswith("linux") and os.geteuid() == 0, "ROOT_REQUIRED")
    need(sys.argv[1:] in ([], ["--apply"], ["--rollback"]), "USAGE")
    if not sys.argv[1:]:
        apply()
        return
    try:
        fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise Blocked("SUPERVISOR_OWNER_LOCK_PRESENT") from None
    os.close(fd)
    try:
        if sys.argv[1:] == ["--rollback"]:
            rollback()
        else:
            apply()
    finally:
        try:
            os.unlink(LOCK)
        except OSError:
            pass


if __name__ == "__main__":
    try:
        run()
    except Blocked as reason:
        safe = re.sub(r"[^A-Z0-9_]", "", str(reason))[:80]
        print("SIGNED27_SUPERVISOR_RESULT=BLOCKED:" + safe)
        sys.exit(1)
