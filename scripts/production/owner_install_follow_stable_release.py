#!/usr/bin/env python3
"""Owner-root, one-time installer for the follow-stable-release timer.

  python3 -I owner_install_follow_stable_release.py            # dry run (default)
  python3 -I owner_install_follow_stable_release.py --apply

Installs only: the follow script (root 0755), one service and one timer.
Does not edit agent configs, signing keys, the stable symlink or any
other unit. Refuses to overwrite a different existing file.
"""
import hashlib
import os
import pathlib
import shutil
import socket
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
LIBEXEC = pathlib.Path("/usr/local/libexec/kmj-codebridge-follow-stable")
UNIT_DIR = pathlib.Path("/etc/systemd/system")
FILES = (
    (HERE / "follow_stable_release.py", LIBEXEC / "follow_stable_release.py", 0o755),
    (HERE / "kmj-codebridge-follow-stable.service", UNIT_DIR / "kmj-codebridge-follow-stable.service", 0o644),
    (HERE / "kmj-codebridge-follow-stable.timer", UNIT_DIR / "kmj-codebridge-follow-stable.timer", 0o644),
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def die(code):
    print("RESULT=BLOCKED:" + code, file=sys.stderr)
    sys.exit(2)


def main(argv):
    apply = argv == ["--apply"]
    if argv and not apply:
        die("USAGE")
    print("MODE=" + ("APPLY" if apply else "DRY_RUN"))
    if os.geteuid() != 0:
        die("NOT_ROOT")
    if socket.gethostname().split(".")[0].lower() != "kmj-elite":
        die("WRONG_HOST")
    plan = []
    for src, dst, mode in FILES:
        if not src.is_file() or src.is_symlink():
            die("SOURCE_MISSING")
        if dst.is_symlink():
            die("DEST_SYMLINK")
        if dst.exists() and digest(dst) != digest(src):
            die("DEST_DIFFERS_NOT_OVERWRITTEN:" + dst.name)
        plan.append((src, dst, mode, dst.exists()))
        print(("ALREADY_PRESENT " if dst.exists() else "WOULD_INSTALL ") + dst.name)
    if not apply:
        print("RESULT=DRY_RUN_UNCHANGED")
        return
    LIBEXEC.mkdir(mode=0o755, parents=True, exist_ok=True)
    for src, dst, mode, present in plan:
        if not present:
            shutil.copyfile(src, dst)
            os.chown(dst, 0, 0)
            os.chmod(dst, mode)
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}
    subprocess.run(["systemctl", "daemon-reload"], check=True, env=env)
    subprocess.run(["systemctl", "enable", "--now", "kmj-codebridge-follow-stable.timer"], check=True, env=env)
    print("RESULT=INSTALLED_TIMER_ENABLED")


if __name__ == "__main__":
    main(sys.argv[1:])
