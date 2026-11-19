#!/usr/bin/env python3
"""KMJ-elite owner-root ONE-TIME installer for the unattended signed release timer.

Installs only: three hash-pinned scripts under /usr/local/lib/kmj-codebridge-release
and two systemd units (service + timer). Dry-run by default; changing anything
needs:  --apply --confirm-unattended-release-owner-go

That flag is the owner's standing consent to apply owner-SIGNED, protected-main,
already-approved releases without a per-release root block. It grants nothing
else: the timer cannot sign, has no arguments, and stops at once if the file
/etc/kmj-codebridge-release/auto-release.disabled exists.

Rollback: any failure removes exactly what this run created. To uninstall later:
  systemctl disable --now kmj-codebridge-auto-release.timer
  and delete the two unit files and the install directory.
"""
import hashlib
import os
import pathlib
import socket
import stat
import subprocess
import sys

SOURCE = pathlib.Path(__file__).resolve().parent
INSTALL_TEXT = "/usr/local/lib/kmj-codebridge-release"
INSTALL_DIR = pathlib.Path(INSTALL_TEXT)
CONF_DIR = pathlib.Path("/etc/kmj-codebridge-release")
UNIT_DIR = pathlib.Path("/etc/systemd/system")
SERVICE = "kmj-codebridge-auto-release.service"
TIMER = "kmj-codebridge-auto-release.timer"
CONFIRM = "--confirm-unattended-release-owner-go"
FILES = {
    "owner_elite_auto_release.py": "59837def9910937b85790834d22c0f202d13278b59658d32a39ebce29d46d66b",
    "owner_elite_release.py": "e11e9d463d432bb0f2fbbc5b0eededbfb554e0f71653dad8d005c3d16f3aafd3",
    "owner_roll_signed_latest_feed_20261115.py":
        "3e0613f8826589c6b718e97cd227899f0fbc65cb97cd0a5aa5afe5de727aa509",
}
SERVICE_UNIT = f"""[Unit]
Description=KMJ CodeBridge owner-signed stable auto release (publish, feed, gateway cutover)
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/etc/kmj-codebridge-release/auto-release.disabled

[Service]
Type=oneshot
User=root
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
RuntimeDirectory=kmj-codebridge-release
RuntimeDirectoryMode=0700
TimeoutStartSec=1500
ExecStart=/usr/bin/python3 -I {INSTALL_TEXT}/owner_elite_auto_release.py
"""
TIMER_UNIT = f"""[Unit]
Description=Check for a new owner-signed CodeBridge release every 10 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
RandomizedDelaySec=60
AccuracySec=30s
Unit={SERVICE}

[Install]
WantedBy=timers.target
"""


class Blocked(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Blocked(code)


def run(*argv, timeout=60):
    try:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("COMMAND_UNAVAILABLE") from None
    return p.returncode, p.stdout.decode("utf-8", "replace").strip()


def write_exclusive(path, data, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        os.fchmod(fd, mode)
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def verified_sources():
    blobs = {}
    for name, digest in FILES.items():
        path = SOURCE / name
        need(path.is_file() and not path.is_symlink(), "SOURCE_FILE_MISSING")
        data = path.read_bytes()
        need(hashlib.sha256(data).hexdigest() == digest, "SOURCE_HASH_MISMATCH")
        blobs[name] = data
    return blobs


def trusted_dir(path, create):
    if not path.exists():
        need(create, "DIRECTORY_ABSENT")
        os.mkdir(path, 0o755)
    st = os.lstat(path)
    need(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022,
         "DIRECTORY_UNTRUSTED")


def main(argv):
    need(argv in ([], ["--apply", CONFIRM]), "INVALID_ARGS")
    apply = bool(argv)
    need(getattr(os, "geteuid", lambda: 1)() == 0
         and socket.gethostname().split(".")[0].lower() == "kmj-elite", "WRONG_ROOT_OR_HOST")
    blobs = verified_sources()
    print("SOURCE_HASHES=PASS")
    need(pathlib.Path("/etc/kmj-codebridge-update/stable-update.json").is_file(),
         "TRUST_FILE_MISSING")
    need(pathlib.Path("/etc/systemd/system/kmj-codebridge-gateway-stage.service").is_file(),
         "GATEWAY_UNIT_MISSING")
    for unit in (SERVICE, TIMER):
        need(not os.path.lexists(UNIT_DIR / unit), "UNIT_ALREADY_EXISTS")
    need(not INSTALL_DIR.is_symlink(), "INSTALL_DIR_UNTRUSTED")
    print("PREFLIGHT=PASS")
    if not apply:
        print("AUTO_RELEASE_INSTALL=DRY_RUN_UNCHANGED")
        return
    created = []
    try:
        trusted_dir(INSTALL_DIR, True)
        trusted_dir(CONF_DIR, True)
        for name, data in blobs.items():
            target = INSTALL_DIR / name
            if os.path.lexists(target):
                need(target.is_file() and not target.is_symlink()
                     and target.read_bytes() == data, "INSTALLED_FILE_DIFFERS")
                continue
            write_exclusive(target, data, 0o644)
            created.append(target)
        write_exclusive(UNIT_DIR / SERVICE, SERVICE_UNIT.encode(), 0o644)
        created.append(UNIT_DIR / SERVICE)
        write_exclusive(UNIT_DIR / TIMER, TIMER_UNIT.encode(), 0o644)
        created.append(UNIT_DIR / TIMER)
        code, _ = run("systemd-analyze", "verify", str(UNIT_DIR / SERVICE), str(UNIT_DIR / TIMER))
        need(code == 0, "UNIT_VERIFY_FAILED")
        need(run("systemctl", "daemon-reload")[0] == 0, "DAEMON_RELOAD_FAILED")
        need(run("systemctl", "enable", "--now", TIMER)[0] == 0, "TIMER_ENABLE_FAILED")
        need(run("systemctl", "is-enabled", TIMER)[1] == "enabled"
             and run("systemctl", "is-active", TIMER)[1] == "active", "TIMER_NOT_ACTIVE")
        print("TIMER=ENABLED_ACTIVE")
        print("AUTO_RELEASE_INSTALL=DONE")
        print("KILL_SWITCH=touch " + str(CONF_DIR / "auto-release.disabled"))
    except BaseException as error:
        reason = error.args[0] if isinstance(error, Blocked) and error.args else "UNCLASSIFIED"
        print("AUTO_RELEASE_INSTALL=BLOCKED:" + str(reason))
        run("systemctl", "disable", "--now", TIMER)
        for path in reversed(created):
            try:
                os.unlink(path)
            except OSError:
                pass
        run("systemctl", "daemon-reload")
        print("ROLLBACK=DONE")
        raise Blocked("INSTALL_FAILED") from None


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Blocked as error:
        print("AUTO_RELEASE_INSTALL=BLOCKED")
        print("REASON=" + (str(error.args[0]) if error.args else "UNCLASSIFIED"))
        sys.exit(2)
    except (OSError, ValueError):
        print("AUTO_RELEASE_INSTALL=BLOCKED")
        print("REASON=UNCLASSIFIED")
        sys.exit(2)
