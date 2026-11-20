#!/usr/bin/env python3
"""KMJ-elite owner-root ONE-CLICK: install a daily LOCAL age-encrypted copy of the newest daily backup.

This is NOT offsite disaster recovery. The copy stays on the same VPS (same disk). It exists so the
KMJ-elite health check ("fresh .tar.age in /var/backups/kmj-elite-offsite-encrypted") stays truthful
without any Google/SFTP dependency. It uses the already pinned age recipient file and never needs a
private key, so the copy cannot be decrypted or restore-tested here.

Default is a DRY RUN. --apply installs exactly three root-owned files and enables one timer:
  /usr/local/sbin/kmj-elite-local-encrypted-copy
  /etc/systemd/system/kmj-elite-local-encrypted-copy.service
  /etc/systemd/system/kmj-elite-local-encrypted-copy.timer
It does not touch the existing daily/offsite units or scripts, any drop-in, the network, the
database, production or staging. An existing different file is never overwritten (blocked).

  python3 -I owner_elite_local_encrypted_copy_timer.py            # dry run
  python3 -I owner_elite_local_encrypted_copy_timer.py --apply
"""
import hashlib
import os
import socket
import subprocess
import sys

SBIN = "/usr/local/sbin/kmj-elite-local-encrypted-copy"
SERVICE = "/etc/systemd/system/kmj-elite-local-encrypted-copy.service"
TIMER = "/etc/systemd/system/kmj-elite-local-encrypted-copy.timer"

SCRIPT = """#!/usr/bin/env bash
# KMJ-elite: daily LOCAL age-encrypted copy of the newest daily backup. Same VPS: NOT offsite DR.
set -Eeuo pipefail
umask 077
test "$(hostname)" = KMJ-elite
exec 9>/run/lock/kmj-elite-local-encrypted-copy.lock
flock -n 9 || { echo LOCAL_ENCRYPTED_COPY_ALREADY_RUNNING; exit 4; }
root=/var/backups/kmj-elite-daily
out=/var/backups/kmj-elite-offsite-encrypted
rcp=/root/kmj-bootstrap/offsite-age-recipients.txt
test -s "$rcp"
install -d -m 0700 "$out"
src=$(find "$root" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort | tail -n 1)
test -n "$src" && test -s "$src/platform.dump" && test -s "$src/SHA256SUMS"
(cd "$src" && sha256sum -c SHA256SUMS >/dev/null)
name=$(basename "$src")
arc="$out/$name.tar.age"
if test ! -s "$arc"; then
  tmp="$arc.partial"
  rm -f -- "$tmp"
  tar -C "$root" -cf - "$name" | age -R "$rcp" -o "$tmp"
  test -s "$tmp"
  mv -- "$tmp" "$arc"
fi
(cd "$out" && sha256sum "$name.tar.age" > "$name.sha256" && sha256sum -c "$name.sha256" >/dev/null)
echo "LOCAL_ENCRYPTED_COPY=PASS name=$name"
echo "OFFSITE_REAL=NO_SAME_VPS_ONLY"
"""

SERVICE_UNIT = """[Unit]
Description=KMJ-elite daily local age-encrypted copy (same VPS, not offsite DR)
After=kmj-elite-daily-backup.service

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/sbin/kmj-elite-local-encrypted-copy
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/var/backups/kmj-elite-offsite-encrypted /run/lock
"""

TIMER_UNIT = """[Unit]
Description=KMJ-elite daily local age-encrypted copy timer

[Timer]
OnCalendar=*-*-* 04:30:00 UTC
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
"""

FILES = ((SBIN, SCRIPT, 0o755), (SERVICE, SERVICE_UNIT, 0o644), (TIMER, TIMER_UNIT, 0o644))


class Blocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Blocked(code)


def parse_args(argv):
    require(len(argv) <= 1 and set(argv) <= {"--apply"}, "UNKNOWN_ARGUMENT")
    return argv == ["--apply"]


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def inspect_host():
    require(getattr(os, "geteuid", lambda: 1)() == 0, "NOT_ROOT")
    require(socket.gethostname().split(".")[0].lower() == "kmj-elite", "WRONG_HOST")
    require(os.path.isfile("/root/kmj-bootstrap/offsite-age-recipients.txt"), "RECIPIENT_FILE_MISSING")
    require(os.path.isdir("/var/backups/kmj-elite-daily") and not os.path.islink("/var/backups/kmj-elite-daily"), "DAILY_DIR_MISSING")
    for path, text, _mode in FILES:
        if os.path.lexists(path):
            require(not os.path.islink(path), "TARGET_IS_LINK")
            with open(path, encoding="utf-8") as src:
                require(src.read() == text, "EXISTING_FILE_DIFFERS")


def write_file(path, text, mode):
    if os.path.lexists(path):
        return "PRESENT_IDENTICAL"
    tmp = path + ".tmp-" + str(os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.write(text)
        out.flush()
        os.fsync(out.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)
    return "WRITTEN"


def systemctl(*args):
    subprocess.run(["/usr/bin/systemctl", *args], check=True, timeout=60)


def main(argv):
    try:
        apply = parse_args(argv)
        inspect_host()
        for path, text, _mode in FILES:
            print("FILE=" + path + " SHA256=" + digest(text))
        print("OFFSITE_REAL=NO_SAME_VPS_ONLY")
        print("RESTORE_VERIFIED=NO_KEY_NOT_ON_THIS_HOST")
        if not apply:
            print("LOCAL_ENCRYPTED_COPY_TIMER=DRY_RUN_NOTHING_WRITTEN")
            return 0
        for path, text, mode in FILES:
            print(path + "=" + write_file(path, text, mode))
        systemctl("daemon-reload")
        systemctl("enable", "--now", "kmj-elite-local-encrypted-copy.timer")
        print("LOCAL_ENCRYPTED_COPY_TIMER=INSTALLED_AND_ENABLED")
        print("EXISTING_DAILY_AND_OFFSITE_UNITS=UNCHANGED")
        return 0
    except Blocked as exc:
        print("LOCAL_ENCRYPTED_COPY_TIMER=BLOCKED_" + str(exc))
        print("NOTHING_CHANGED")
        return 2
    except (OSError, subprocess.SubprocessError):
        print("LOCAL_ENCRYPTED_COPY_TIMER=BLOCKED_OPERATOR_FAILURE")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
