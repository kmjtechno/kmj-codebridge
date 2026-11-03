#!/usr/bin/env python3
"""Guarded on-disk-only isolated CloudOS uploader SSHD policy stage.

This script is operator-run, root-only on exact kmj-elite. It requires the
previously observed no-Match topology and isolated nologin uploader. It
captures administrator effective-policy baselines, verifies the candidate
before any production config change, writes a private original backup, then
atomically stages ONLY sshd_config. On post-write verification failure it
restores original bytes atomically and fails closed.

No sshd reload, restart, public-key installation, AGE setup, backup upload,
VM boot or cloud API request occurs here. Disk staging is NOT live SFTP.
"""
from __future__ import annotations

import os
import pwd
import secrets
import stat
import subprocess
import sys
import tempfile

HOST = "kmj-elite"
SSH_DIR = "/etc/ssh"
MAIN = "/etc/ssh/sshd_config"
ROOT_TEMP_DIR = "/root"
BACKUP = "/root/kmj-cloudos-sshd-before-sftp-20261103.conf"
USER = "kmjcloudosbackup"
SSHD = "/usr/sbin/sshd"
LIMIT = 65536
IPS = ("127.0.0.1", "10.128.0.2")
ADMINS = ("root", "kmjcode", "kmjcloudosdev")
EXPECTED = {
    "chrootdirectory": "/srv/kmj-cloudos-n2-sftp",
    "forcecommand": "internal-sftp -d /incoming",
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
STANZA = (
    "\n# KMJ CloudOS uploader: manually reviewed isolated policy\n"
    "Match User kmjcloudosbackup\n"
    "    ChrootDirectory /srv/kmj-cloudos-n2-sftp\n"
    "    ForceCommand internal-sftp -d /incoming\n"
    "    PasswordAuthentication no\n"
    "    KbdInteractiveAuthentication no\n"
    "    PubkeyAuthentication yes\n"
    "    PermitTTY no\n"
    "    AllowTcpForwarding no\n"
    "    AllowAgentForwarding no\n"
    "    X11Forwarding no\n"
    "    PermitTunnel no\n"
    "    AuthorizedKeysFile /etc/ssh/authorized_keys/%u\n"
    "    PermitOpen none\n"
    "    PermitListen none\n"
).encode("ascii")
D = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
F = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC


class Blocked(RuntimeError):
    pass


def directory(fd, uid=0, mode=None):
    s = os.fstat(fd)
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != uid or s.st_mode & 0o022:
        raise Blocked("UNTRUSTED_DIRECTORY")
    if mode is not None and stat.S_IMODE(s.st_mode) != mode:
        raise Blocked("DIRECTORY_MODE_MISMATCH")


def read_conf():
    f = os.open(MAIN, F)
    try:
        s = os.fstat(f)
        if (not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or
                s.st_mode & 0o022 or s.st_nlink != 1 or
                not 16 <= s.st_size <= LIMIT):
            raise Blocked("UNTRUSTED_EXISTING_CONFIG")
        data = os.read(f, LIMIT + 1)
        if len(data) != s.st_size:
            raise Blocked("CONCURRENT_CONFIG_READ")
        return data, s
    finally:
        os.close(f)


def preflight():
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("EXACT_ELITE_ROOT_REQUIRED")
    root = os.open("/", D)
    try:
        directory(root)
        etc = os.open("etc", D, dir_fd=root)
        try:
            directory(etc)
            ssh = os.open("ssh", D, dir_fd=etc)
            try:
                directory(ssh)
                try:
                    drop = os.open("sshd_config.d", D, dir_fd=ssh)
                except FileNotFoundError:
                    drop = None
                if drop is not None:
                    try:
                        directory(drop)
                        if any(name.endswith(".conf") for name in os.listdir(drop)):
                            raise Blocked("UNEXPECTED_DROPIN")
                    finally:
                        os.close(drop)
            finally:
                os.close(ssh)
        finally:
            os.close(etc)
        srv = os.open("srv", D, dir_fd=root)
        try:
            directory(srv)
            try:
                account = pwd.getpwnam(USER)
            except KeyError:
                raise Blocked("UPLOADER_ACCOUNT_MISSING") from None
            if (account.pw_uid < 1000 or
                    account.pw_shell != "/usr/sbin/nologin" or
                    account.pw_dir != "/nonexistent"):
                raise Blocked("UPLOADER_ACCOUNT_UNSAFE")
            for name, uid, mode in (
                ("kmj-cloudos-n2-offsite", 0, 0o700),
                ("kmj-cloudos-n2-sftp", 0, 0o755),
            ):
                fd = os.open(name, D, dir_fd=srv)
                try:
                    directory(fd, uid, mode)
                    if name.endswith("-sftp"):
                        incoming = os.open("incoming", D, dir_fd=fd)
                        try:
                            directory(incoming, account.pw_uid, 0o700)
                        finally:
                            os.close(incoming)
                finally:
                    os.close(fd)
        finally:
            os.close(srv)
    finally:
        os.close(root)

    original, info = read_conf()
    try:
        active = [line.strip().split()
                  for line in original.decode("ascii").splitlines()
                  if line.strip() and not line.lstrip().startswith("#")]
    except UnicodeError:
        raise Blocked("SSH_CONFIG_NOT_ASCII") from None
    if any(x[0].lower() == "match" for x in active):
        raise Blocked("CONFIG_ALREADY_HAS_MATCH")
    includes = [x[1:] for x in active if x[0].lower() == "include"]
    if includes != [["/etc/ssh/sshd_config.d/*.conf"]]:
        raise Blocked("UNEXPECTED_INCLUDE_TOPOLOGY")
    return original, info


def query(config=None, user=None, addr="127.0.0.1"):
    cmd = [SSHD, "-t"] if user is None else [
        SSHD, "-T", "-C", f"user={user},host=relay,addr={addr}"
    ]
    if config is not None:
        cmd += ["-f", config]
    try:
        p = subprocess.run(cmd, stdin=subprocess.DEVNULL,
                           capture_output=True, check=False, timeout=12)
    except (subprocess.TimeoutExpired, OSError):
        raise Blocked("SSHD_QUERY_UNAVAILABLE_OR_TIMEOUT") from None
    if p.returncode or len(p.stdout) > LIMIT:
        raise Blocked("SSHD_QUERY_FAILED")
    return p.stdout


def effective(blob):
    result = {}
    for line in blob.decode("utf-8", "strict").splitlines():
        pair = line.strip().split(None, 1)
        if len(pair) != 2:
            continue
        k, value = pair
        k = k.lower()
        if k in result:
            if k in EXPECTED:
                raise Blocked("DUPLICATE_PROTECTED_POLICY_OPTION")
            continue
        result[k] = value
    return result


def baseline():
    query()
    present = []
    for name in ADMINS:
        try:
            pwd.getpwnam(name)
        except KeyError:
            continue
        present.append(name)
    if "root" not in present or len(present) < 2:
        raise Blocked("ADMIN_BASELINE_IDENTITIES_INCOMPLETE")
    return {(u, addr): query(user=u, addr=addr) for u in present for addr in IPS}


def verify(candidate, admin):
    query(candidate)
    for (u, addr), before in admin.items():
        if query(candidate, u, addr) != before:
            raise Blocked("ADMIN_POLICY_CHANGED")
    for addr in IPS:
        settings = effective(query(candidate, USER, addr))
        if any(settings.get(k) != v for k, v in EXPECTED.items()):
            raise Blocked("UPLOADER_RESTRICTIONS_NOT_VERIFIED")


def write_new(path, content, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        remaining = memoryview(content)
        while remaining:
            written = os.write(fd, remaining)
            if written < 1:
                raise Blocked("SHORT_WRITE")
            remaining = remaining[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def apply(original, info, admin):
    candidate = original + (b"" if original.endswith(b"\n") else b"\n") + STANZA
    if len(candidate) > LIMIT:
        raise Blocked("CANDIDATE_TOO_LARGE")
    with tempfile.NamedTemporaryFile(dir=ROOT_TEMP_DIR, prefix="kmj-ssh-preflight-",
                                     suffix=".conf", delete=True) as preflight_file:
        preflight_file.write(candidate)
        preflight_file.flush()
        os.fsync(preflight_file.fileno())
        verify(preflight_file.name, admin)
    print("ELITE_SSHD_CANDIDATE_AND_ADMIN_POLICY=PASS", flush=True)

    now, state = read_conf()
    if (now != original or state.st_ino != info.st_ino or
            state.st_mtime_ns != info.st_mtime_ns):
        raise Blocked("SSH_CONFIG_CHANGED_BEFORE_APPLY")
    # Protected original backup. Never remove or overwrite it on retries.
    write_new(BACKUP, original, 0o600)
    print("ELITE_ORIGINAL_SSHD_BACKUP=ROOT_ONLY_SAVED", flush=True)
    temp = SSH_DIR + "/.kmj-sshd-stage-" + secrets.token_hex(10)
    original_mode = stat.S_IMODE(info.st_mode)
    try:
        write_new(temp, candidate, 0o600)
        os.chmod(temp, original_mode, follow_symlinks=False)
        verify(temp, admin)
        os.replace(temp, MAIN)
        temp = None
        try:
            parent_fd = os.open(SSH_DIR, D)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
            verify(None, admin)
        except (Blocked, OSError, UnicodeError):
            restore = SSH_DIR + "/.kmj-sshd-rollback-" + secrets.token_hex(10)
            try:
                write_new(restore, original, 0o600)
                os.chmod(restore, original_mode, follow_symlinks=False)
                os.replace(restore, MAIN)
                restore = None
                parent_fd = os.open(SSH_DIR, D)
                try:
                    os.fsync(parent_fd)
                finally:
                    os.close(parent_fd)
            finally:
                if restore and os.path.exists(restore):
                    os.unlink(restore)
            query()
            if read_conf()[0] != original:
                raise Blocked("CRITICAL_ROLLBACK_UNVERIFIED")
            raise Blocked("POST_WRITE_FAILURE_ROLLED_BACK") from None
    finally:
        if temp is not None and os.path.exists(temp):
            os.unlink(temp)

    print("ELITE_SSHD_RESTRICTED_SFTP_POLICY=STAGED_DISK_ONLY", flush=True)
    print("ELITE_ADMIN_EFFECTIVE_POLICY=UNCHANGED_VERIFIED", flush=True)
    print("ELITE_SSHD_RELOAD=NOT_ATTEMPTED", flush=True)
    print("ELITE_AUTHENTICATED_SFTP_LOGIN=NOT_ATTEMPTED", flush=True)
    print("ELITE_OWNER_AGE_RECOVERY=NOT_VERIFIED", flush=True)
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)


def self_test():
    assert b"Match User kmjcloudosbackup" in STANZA
    assert b"PermitUserEnvironment" not in STANZA
    assert EXPECTED["permituserenvironment"] == "no"
    assert STANZA.endswith(b"PermitListen none\n")
    assert effective(b"hostkey /one\nhostkey /two\n")["hostkey"] == "/one"
    for k, v in EXPECTED.items():
        try:
            effective((f"{k} {v}\n{k} {v}\n").encode())
        except Blocked:
            pass
        else:
            raise AssertionError("Duplicate protected key accepted")
    print("ELITE_SSHD_STAGING_OFFLINE_TESTS=PASS")


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:] not in (["--inspect"], ["--stage"]):
        print("USAGE: script --inspect | --stage | --self-test")
        return 64
    try:
        os.umask(0o077)
        original, info = preflight()
        admin = baseline()
        print("ELITE_CURRENT_ADMIN_SSHD_BASELINE=CAPTURED", flush=True)
        if sys.argv[1:] == ["--inspect"]:
            print("ELITE_SSHD_POLICY_STAGE=READ_ONLY_PREFLIGHT_PASS", flush=True)
        else:
            apply(original, info, admin)
        return 0
    except (Blocked, OSError, UnicodeError) as error:
        print("ELITE_SSHD_POLICY_STAGE=BLOCKED", flush=True)
        if isinstance(error, Blocked):
            print("ELITE_SSHD_STAGE_REASON=" + str(error)[:90], flush=True)
        else:
            print("ELITE_SSHD_STAGE_REASON=FILESYSTEM_OR_OUTPUT_ERROR", flush=True)
        print("ELITE_SSHD_RELOAD=NOT_ATTEMPTED", flush=True)
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
