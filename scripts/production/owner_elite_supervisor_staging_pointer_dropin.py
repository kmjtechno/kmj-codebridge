#!/usr/bin/env python3
"""KMJ-elite owner-root ONE-CLICK: let the Supervisor read the staging release pointer (read-only).

Problem: kmj-codebridge-supervisor.service runs with ProtectHome=tmpfs and only binds /home/kmjprod,
so /home/kmjstage/htdocs/staging.kmjtechno.com is invisible and the staging policy reports
STAGING_POINTER_UNVERIFIED (the guarded staging deploy can never become ready).

Fix: one systemd drop-in that adds ONLY `BindReadOnlyPaths=-/home/kmjstage/htdocs` (the directory holding
the staging symlink; the policy only does lstat/readlink on that link). Nothing else under /home/kmjstage
becomes visible, and it is read-only.

Default is a DRY RUN. --apply:
  1. checks host/root/units and that no guarded release unit is running,
  2. writes /etc/systemd/system/kmj-codebridge-supervisor.service.d/30-main-platform-staging-pointer.conf,
  3. daemon-reload, restarts ONLY kmj-codebridge-supervisor.service (CodeBridge Supervisor tools are briefly
     unavailable), waits for it and its socket,
  4. on any failure removes the drop-in, reloads and restarts again (automatic rollback) and says so.
It touches no application, database, release pointer, staging/production unit, DNS, network or secret.

  python3 -I owner_elite_supervisor_staging_pointer_dropin.py            # dry run
  python3 -I owner_elite_supervisor_staging_pointer_dropin.py --apply
"""
import os
import socket
import stat
import subprocess
import sys
import time

UNIT = "kmj-codebridge-supervisor.service"
DROPIN_DIR = "/etc/systemd/system/" + UNIT + ".d"
EXISTING = DROPIN_DIR + "/20-main-platform-production-readonly.conf"
DROPIN = DROPIN_DIR + "/30-main-platform-staging-pointer.conf"
SOCKET = "/run/kmj-codebridge/supervisor.sock"
STAGING_DIR = "/home/kmjstage/htdocs"
STAGING_LINK = STAGING_DIR + "/staging.kmjtechno.com"
BUSY_UNITS = (
    "kmj-main-platform-production-release.service",
    "kmj-main-platform-staging-deploy.service",
)

CONTENT = """# Read-only visibility of ONLY the staging pointer directory for the Supervisor
# staging policy (lstat/readlink of the staging symlink). Requires the 20-* drop-in's
# ProtectHome=tmpfs. The leading '-' ignores a missing path instead of failing the unit.
[Service]
BindReadOnlyPaths=-/home/kmjstage/htdocs
"""


class Blocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Blocked(code)


def parse_args(argv):
    require(len(argv) <= 1 and set(argv) <= {"--apply"}, "UNKNOWN_ARGUMENT")
    return argv == ["--apply"]


def ctl(*args, check=True):
    return subprocess.run(
        ["/usr/bin/systemctl", *args],
        check=check, timeout=90, capture_output=True, text=True,
    )


def is_active(name):
    return ctl("is-active", name, check=False).stdout.strip()


def inspect_host():
    require(getattr(os, "geteuid", lambda: 1)() == 0, "NOT_ROOT")
    require(socket.gethostname().split(".")[0].lower() == "kmj-elite", "WRONG_HOST")
    st = os.lstat(STAGING_DIR) if os.path.lexists(STAGING_DIR) else None
    require(st is not None and stat.S_ISDIR(st.st_mode), "STAGING_DIR_MISSING_OR_LINK")
    require(os.path.islink(STAGING_LINK), "STAGING_LINK_NOT_SYMLINK")
    require(os.path.isfile(EXISTING) and not os.path.islink(EXISTING), "PRODUCTION_DROPIN_MISSING")
    with open(EXISTING, encoding="utf-8") as src:
        text = src.read()
    require("ProtectHome=tmpfs" in text and "BindReadOnlyPaths=/home/kmjprod" in text, "PRODUCTION_DROPIN_UNEXPECTED")
    require(is_active(UNIT) == "active", "SUPERVISOR_NOT_ACTIVE")
    for name in BUSY_UNITS:
        require(is_active(name) not in ("active", "activating", "deactivating"), "RELEASE_UNIT_BUSY")
    if os.path.lexists(DROPIN):
        require(not os.path.islink(DROPIN), "DROPIN_IS_LINK")
        with open(DROPIN, encoding="utf-8") as src:
            require(src.read() == CONTENT, "EXISTING_DROPIN_DIFFERS")


def wait_healthy():
    for _ in range(20):
        if is_active(UNIT) == "active" and os.path.exists(SOCKET):
            return True
        time.sleep(1)
    return False


def rollback():
    try:
        if os.path.lexists(DROPIN):
            os.unlink(DROPIN)
        ctl("daemon-reload")
        ctl("restart", UNIT)
    except (OSError, subprocess.SubprocessError):
        return False
    return wait_healthy()


def write_dropin():
    if os.path.lexists(DROPIN):
        return "PRESENT_IDENTICAL"
    tmp = DROPIN + ".tmp-" + str(os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.write(CONTENT)
        out.flush()
        os.fsync(out.fileno())
    os.chmod(tmp, 0o644)
    os.replace(tmp, DROPIN)
    return "WRITTEN"


def main(argv):
    try:
        apply = parse_args(argv)
        inspect_host()
        print("SUPERVISOR_STAGING_POINTER_HOST_CHECKS=PASS")
        print("WILL_ADD=BindReadOnlyPaths=-" + STAGING_DIR + " (read-only, directory with the staging symlink only)")
        if not apply:
            print("WILL_RESTART=" + UNIT + " (Supervisor tools briefly unavailable)")
            print("SUPERVISOR_STAGING_POINTER=DRY_RUN_NOTHING_CHANGED")
            return 0
        print("DROPIN=" + write_dropin())
        try:
            ctl("daemon-reload")
            ctl("restart", UNIT)
            healthy = wait_healthy()
        except (OSError, subprocess.SubprocessError):
            healthy = False
        if not healthy:
            print("SUPERVISOR_STAGING_POINTER=FAILED_ROLLED_BACK_" + ("OK" if rollback() else "CHECK_MANUALLY"))
            return 2
        print("SUPERVISOR_STAGING_POINTER=INSTALLED_SUPERVISOR_ACTIVE_SOCKET_PRESENT")
        print("ONLY_SUPERVISOR_RESTARTED=YES")
        return 0
    except Blocked as exc:
        print("SUPERVISOR_STAGING_POINTER=BLOCKED_" + str(exc))
        print("NOTHING_CHANGED")
        return 2
    except (OSError, subprocess.SubprocessError):
        print("SUPERVISOR_STAGING_POINTER=BLOCKED_OPERATOR_FAILURE")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
