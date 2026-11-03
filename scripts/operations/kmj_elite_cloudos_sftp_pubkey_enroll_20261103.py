#!/usr/bin/env python3
"""Enroll exactly one approved public ED25519 SFTP uploader key on KMJ-elite.

Operator root, exact-host, explicit --install with independent relay SHA256
fingerprint. Only a new public-only file inside /etc/ssh/authorized_keys may
be created, never overwritten. Private keys and passwords are never read.
The SSH daemon is not reloaded; real SFTP must be separately authenticated.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import os
import pwd
import re
import stat
import subprocess
import sys
from pathlib import Path

HOST = "kmj-elite"
UPLOADER = "kmjcloudosbackup"
INPUT = Path("/root/kmj-cloudos-relay-sftp-public-ed25519.pub")
DIR = Path("/etc/ssh/authorized_keys")
DEST = DIR / UPLOADER
COMMENT = "kmj-cloudos-n2-relay-sftp"
FINGERPRINT = re.compile(r"SHA256:[A-Za-z0-9+/]{43}\Z")
KEYDATA = re.compile(r"[A-Za-z0-9+/]+={0,2}\Z")
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC
CONTROL = {
    "forcecommand": "internal-sftp -d /incoming",
    "chrootdirectory": "/srv/kmj-cloudos-n2-sftp",
    "passwordauthentication": "no",
    "kbdinteractiveauthentication": "no",
    "pubkeyauthentication": "yes",
    "permittty": "no",
    "allowtcpforwarding": "no",
    "allowagentforwarding": "no",
    "x11forwarding": "no",
    "permittunnel": "no",
    "permituserenvironment": "no",
    "authorizedkeysfile": "/etc/ssh/authorized_keys/%u",
    "permitopen": "none",
    "permitlisten": "none",
}


class Blocked(RuntimeError):
    pass


def parse_public(text):
    if len(text.encode("ascii", "strict")) > 1024:
        raise Blocked("PUBLIC_KEY_TOO_LARGE")
    fields = text.strip().split()
    if (len(fields) != 3 or fields[0] != "ssh-ed25519"
            or fields[2] != COMMENT or not KEYDATA.fullmatch(fields[1])):
        raise Blocked("PUBLIC_KEY_FORMAT_OR_IDENTITY_INVALID")
    try:
        raw = base64.b64decode(fields[1], validate=True)
    except (ValueError, binascii.Error):
        raise Blocked("PUBLIC_KEY_BASE64_INVALID") from None
    if (len(raw) != 51 or raw[:15] != b"\x00\x00\x00\x0bssh-ed25519"
            or raw[15:19] != b"\x00\x00\x00\x20"):
        raise Blocked("PUBLIC_KEY_ED25519_BLOB_INVALID")
    fp = "SHA256:" + base64.b64encode(
        hashlib.sha256(raw).digest()).decode("ascii").rstrip("=")
    return ("ssh-ed25519 " + fields[1] + " " + COMMENT + "\n").encode(), fp


def checked_file(folderfd, basename, *, mode=None):
    fd = os.open(basename, os.O_RDONLY | NOFOLLOW, dir_fd=folderfd)
    try:
        s = os.fstat(fd)
        if (not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or
                s.st_nlink != 1 or s.st_mode & 0o022 or
                not 40 <= s.st_size <= 1024):
            raise Blocked("PUBLIC_KEY_FILE_UNTRUSTED")
        if mode is not None and stat.S_IMODE(s.st_mode) != mode:
            raise Blocked("PUBLIC_KEY_FILE_MODE_MISMATCH")
        raw = os.read(fd, 1025)
        if len(raw) != s.st_size:
            raise Blocked("PUBLIC_KEY_FILE_READ_CHANGED")
        return raw
    finally:
        os.close(fd)


def checked_dir(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        os.close(fd)
        raise Blocked("TRUSTED_DIRECTORY_REQUIREMENTS_NOT_MET")
    return fd


def sshd_policy():
    try:
        p = subprocess.run(["/usr/sbin/sshd", "-t"],
                           capture_output=True, stdin=subprocess.DEVNULL,
                           timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("SSHD_SYNTAX_QUERY_UNAVAILABLE") from None
    if p.returncode:
        raise Blocked("SSHD_SYNTAX_NOT_VALID")
    for addr in ("127.0.0.1", "10.128.0.2"):
        try:
            proc = subprocess.run(
                ["/usr/sbin/sshd", "-T", "-C",
                 f"user={UPLOADER},host=relay,addr={addr}"],
                capture_output=True, stdin=subprocess.DEVNULL,
                timeout=10, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise Blocked("SSHD_EFFECTIVE_QUERY_UNAVAILABLE") from None
        if proc.returncode or len(proc.stdout) > 65536:
            raise Blocked("SSHD_EFFECTIVE_POLICY_NOT_OBTAINED")
        setting = {}
        for line in proc.stdout.decode("utf-8", "strict").splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) != 2:
                continue
            key, value = parts
            key = key.lower()
            if key in CONTROL and key in setting:
                raise Blocked("DUPLICATE_UPLOADER_POLICY")
            if key not in setting:
                setting[key] = value
        if any(setting.get(k) != v for k, v in CONTROL.items()):
            raise Blocked("UPLOADER_SSHD_RESTRICTED_POLICY_MISMATCH")
    print("ELITE_SFTP_UPLOADER_SSHD_EFFECTIVE_POLICY=PASS")


def host():
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("EXACT_ELITE_ROOT_REQUIRED")
    try:
        account = pwd.getpwnam(UPLOADER)
    except KeyError:
        raise Blocked("EXPECTED_UPLOADER_ACCOUNT_MISSING") from None
    if (account.pw_uid < 1000 or account.pw_shell != "/usr/sbin/nologin"
            or account.pw_dir != "/nonexistent"):
        raise Blocked("UPLOADER_IDENTITY_CHANGED")
    root = os.open("/", os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        if os.fstat(root).st_uid != 0:
            raise Blocked("UNTRUSTED_ROOT_DIRECTORY")
        etc = checked_dir(root, "etc")
        try:
            ssh = checked_dir(etc, "ssh")
        finally:
            os.close(etc)
        private = checked_dir(root, "root")
        try:
            source = checked_file(private, INPUT.name, mode=0o600) \
                if INPUT.exists() or INPUT.is_symlink() else None
        finally:
            os.close(private)
    finally:
        os.close(root)
    return ssh, source


def ensure_directory(sshfd, install):
    try:
        directory = checked_dir(sshfd, "authorized_keys")
    except FileNotFoundError:
        if not install:
            return None
        os.mkdir("authorized_keys", mode=0o700, dir_fd=sshfd)
        directory = checked_dir(sshfd, "authorized_keys")
    return directory


def status(install, expected_fp=None):
    sshd_policy()
    sshfd, source = host()
    try:
        if install:
            if not source:
                raise Blocked("ROOT_0600_PUBLIC_KEY_INPUT_REQUIRED")
            line, fp = parse_public(source.decode("ascii", "strict"))
            if not FINGERPRINT.fullmatch(expected_fp or "") or fp != expected_fp:
                raise Blocked("APPROVED_RELAY_KEY_FINGERPRINT_MISMATCH")
        directory = ensure_directory(sshfd, install)
        if directory is None:
            print("ELITE_SFTP_UPLOADER_AUTHORIZED_KEY=ABSENT")
            return
        try:
            try:
                existing = checked_file(directory, UPLOADER, mode=0o600)
            except FileNotFoundError:
                existing = None
            if existing is not None:
                existing_bytes, existing_fp = parse_public(
                    existing.decode("ascii", "strict"))
                if existing_bytes != existing:
                    raise Blocked("EXISTING_AUTHORIZED_KEY_NOT_CANONICAL")
                if install:
                    if existing_bytes != line or existing_fp != expected_fp:
                        raise Blocked("ALREADY_AUTHORIZED_DIFFERENT_KEY_REFUSE_OVERWRITE")
                print("ELITE_SFTP_UPLOADER_AUTHORIZED_KEY=EXISTING_VERIFIED")
                print("ELITE_SFTP_UPLOADER_KEY_FINGERPRINT=" + existing_fp)
            elif install:
                fd = os.open(UPLOADER, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                             NOFOLLOW, 0o600, dir_fd=directory)
                try:
                    with os.fdopen(fd, "wb", closefd=True) as stream:
                        stream.write(line)
                        stream.flush()
                        os.fsync(stream.fileno())
                except BaseException:
                    try:
                        os.unlink(UPLOADER, dir_fd=directory)
                    except OSError:
                        pass
                    raise
                if checked_file(directory, UPLOADER, mode=0o600) != line:
                    raise Blocked("POSTWRITE_KEY_CONTENT_MISMATCH")
                os.fsync(directory)
                print("ELITE_SFTP_UPLOADER_AUTHORIZED_KEY=PUBLIC_ONLY_CREATED")
                print("ELITE_SFTP_UPLOADER_KEY_FINGERPRINT=" + fp)
            else:
                print("ELITE_SFTP_UPLOADER_AUTHORIZED_KEY=ABSENT")
        finally:
            os.close(directory)
    finally:
        os.close(sshfd)
    print("ELITE_SSHD_RELOAD=NOT_ATTEMPTED")
    print("ELITE_RELAY_TO_ELITE_AUTHENTICATED_SFTP=NOT_ATTEMPTED")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")


def self_test():
    blob = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
    line = "ssh-ed25519 " + base64.b64encode(blob).decode() + " " + COMMENT
    normalized, fp = parse_public(line)
    assert normalized == (line + "\n").encode()
    assert FINGERPRINT.fullmatch(fp)
    for candidate in ("ssh-rsa " + line.split()[1] + " " + COMMENT,
                      line.replace(COMMENT, "wrong"),
                      "ssh-ed25519 bogus " + COMMENT):
        try:
            parse_public(candidate)
        except Blocked:
            pass
        else:
            raise AssertionError("invalid public key accepted")
    assert CONTROL["forcecommand"] == "internal-sftp -d /incoming"
    assert CONTROL["passwordauthentication"] == "no"
    assert CONTROL["authorizedkeysfile"] == "/etc/ssh/authorized_keys/%u"
    print("ELITE_SFTP_PUBLIC_KEY_ENROLL_OFFLINE_TESTS=PASS")


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:] == ["--inspect"]:
        install = False
        fp = None
    elif len(sys.argv) == 3 and sys.argv[1] == "--install":
        install = True
        fp = sys.argv[2]
    else:
        print("USAGE: script.py --self-test | --inspect | --install SHA256:fingerprint")
        return 64
    try:
        os.umask(0o077)
        status(install, fp)
        return 0
    except (Blocked, OSError, UnicodeError) as exc:
        print("ELITE_SFTP_PUBLIC_KEY_ENROLL=BLOCKED")
        print("ELITE_KEY_ENROLL_REASON=" +
              (str(exc)[:90] if isinstance(exc, Blocked)
               else "FILESYSTEM_OR_OUTPUT_ERROR"))
        print("ELITE_RELAY_TO_ELITE_AUTHENTICATED_SFTP=NOT_ATTEMPTED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
