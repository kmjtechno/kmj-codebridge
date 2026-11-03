#!/usr/bin/env python3
"""Evaluate an isolated CloudOS uploader sshd candidate without installing it.

This *only* creates an auto-deleted private temporary candidate in /root.
It never writes /etc/ssh, reloads sshd, configures keys, or permits logins.
The only PASS available means the hypothetical Match policy parses correctly,
preserves sampled admin sshd -T output, and restricts the uploader in two
simulated SSH connection contexts. Real remote login remains NOT_TESTED.
"""
from __future__ import annotations

import os
import pwd
import stat
import subprocess
import sys
import tempfile

HOST = "kmj-elite"
UPLOADER = "kmjcloudosbackup"
CONFIG = "/etc/ssh/sshd_config"
SSHD = "/usr/sbin/sshd"
MAX_BYTES = 65536
REQUIRED_INCLUDE = "/etc/ssh/sshd_config.d/*.conf"
D = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
F = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC

RESTRICTIONS = {
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
    "\n# Candidate only: not installed by this dry run\n"
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
    "    PermitUserEnvironment no\n"
    "    AuthorizedKeysFile /etc/ssh/authorized_keys/%u\n"
    "    PermitOpen none\n"
    "    PermitListen none\n"
).encode("ascii")
CONTEXT_IPS = ("127.0.0.1", "10.128.0.2")
ADMIN_CANDIDATES = ("root", "kmjcode", "kmjcloudosdev")


class Blocked(RuntimeError):
    pass


def check_directory(info, owner=0, mode=None):
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != owner
            or info.st_mode & 0o022):
        raise Blocked("UNTRUSTED_DIRECTORY")
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise Blocked("UNEXPECTED_DIRECTORY_MODE")


def inspect_preconditions():
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("EXACT_ELITE_ROOT_REQUIRED")
    handles = []
    try:
        root = os.open("/", D)
        handles.append(root)
        check_directory(os.fstat(root))
        etc = os.open("etc", D, dir_fd=root)
        handles.append(etc)
        check_directory(os.fstat(etc))
        ssh = os.open("ssh", D, dir_fd=etc)
        handles.append(ssh)
        check_directory(os.fstat(ssh))
        config = os.open("sshd_config", F, dir_fd=ssh)
        handles.append(config)
        meta = os.fstat(config)
        if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0
                or meta.st_mode & 0o022 or meta.st_nlink != 1
                or not 16 <= meta.st_size <= MAX_BYTES):
            raise Blocked("UNTRUSTED_SSHD_CONFIG")
        raw = os.read(config, MAX_BYTES + 1)
        if len(raw) != meta.st_size:
            raise Blocked("SSH_CONFIG_CHANGED_DURING_READ")
        try:
            lines = raw.decode("ascii").splitlines()
        except UnicodeError:
            raise Blocked("SSHD_CONFIG_NOT_ASCII") from None
        active = [
            row.lstrip().split()
            for row in lines
            if row.strip() and not row.lstrip().startswith("#")
        ]
        inc = [row[1:] for row in active if row[0].lower() == "include"]
        if inc != [[REQUIRED_INCLUDE]] or any(
                row[0].lower() == "match" for row in active):
            raise Blocked("SSH_INCLUDE_MATCH_TOPOLOGY_CHANGED")
        try:
            includes = os.open("sshd_config.d", D, dir_fd=ssh)
        except FileNotFoundError:
            includes = None
        if includes is not None:
            handles.append(includes)
            check_directory(os.fstat(includes))
            if any(n.endswith(".conf") for n in os.listdir(includes)):
                raise Blocked("SSHD_DROPIN_PRESENT_UNEXPECTED")
        try:
            account = pwd.getpwnam(UPLOADER)
        except KeyError:
            raise Blocked("SFTP_UPLOADER_MISSING") from None
        if (account.pw_uid < 1000 or
                account.pw_shell != "/usr/sbin/nologin" or
                account.pw_dir != "/nonexistent"):
            raise Blocked("UPLOADER_ACCOUNT_CHANGED")
        srv = os.open("srv", D, dir_fd=root)
        handles.append(srv)
        check_directory(os.fstat(srv))
        for name, owner, mode in (
            ("kmj-cloudos-n2-offsite", 0, 0o700),
            ("kmj-cloudos-n2-sftp", 0, 0o755)
        ):
            directory = os.open(name, D, dir_fd=srv)
            try:
                check_directory(os.fstat(directory), owner, mode)
                if name.endswith("-sftp"):
                    incoming = os.open("incoming", D, dir_fd=directory)
                    try:
                        check_directory(os.fstat(incoming), account.pw_uid, 0o700)
                    finally:
                        os.close(incoming)
            finally:
                os.close(directory)
        return raw, meta
    except OSError:
        raise Blocked("HOST_PRECONDITION_FILESYSTEM_UNAVAILABLE") from None
    finally:
        for handle in reversed(handles):
            os.close(handle)


def run_sshd(path=None, user=None, addr="127.0.0.1"):
    args = [SSHD, "-t"] if user is None else [
        SSHD, "-T", "-C", f"user={user},host=relay,addr={addr}"
    ]
    if path:
        args += ["-f", path]
    try:
        proc = subprocess.run(args, capture_output=True, check=False,
                              stdin=subprocess.DEVNULL, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("SSHD_QUERY_TIMEOUT_OR_UNAVAILABLE") from None
    if proc.returncode or len(proc.stdout) > 65536:
        raise Blocked("SSHD_QUERY_INVALID")
    return proc.stdout


def parse_policy(blob):
    result = {}
    for row in blob.decode("utf-8", "strict").splitlines():
        pair = row.strip().split(None, 1)
        if len(pair) != 2:
            continue
        name, value = pair
        name = name.lower()
        if name in result and name in RESTRICTIONS:
            raise Blocked("DUPLICATE_PROTECTED_SETTING")
        if name not in result:
            result[name] = value
    return result


def evaluate():
    original, original_meta = inspect_preconditions()
    print("ELITE_ROOT_SFTP_FILESYSTEM_STAGING=PASS")
    run_sshd()
    admins = [
        name for name in ADMIN_CANDIDATES
        if name == "root" or any(
            user.pw_name == name for user in pwd.getpwall())
    ]
    if "root" not in admins or len(admins) < 2:
        raise Blocked("INSUFFICIENT_ADMIN_BASELINE_IDENTITIES")
    baseline = {
        (name, ip): run_sshd(user=name, addr=ip)
        for name in admins for ip in CONTEXT_IPS
    }
    print("ELITE_CURRENT_SSHD_ADMIN_POLICY_BASELINE=CAPTURED")
    candidate = original + (b"" if original.endswith(b"\n") else b"\n") + STANZA
    if len(candidate) > MAX_BYTES:
        raise Blocked("CANDIDATE_CONFIG_OVERSIZE")
    # Never use /etc/ssh for temporary candidate. File auto-deleted on close.
    with tempfile.NamedTemporaryFile(
        mode="w+b", dir="/root", prefix="kmj-sftp-sshd-candidate-",
        suffix=".conf", delete=True,
    ) as temp:
        temp.write(candidate)
        temp.flush()
        os.fsync(temp.fileno())
        run_sshd(temp.name)
        for (name, ip), before in baseline.items():
            if run_sshd(temp.name, name, ip) != before:
                raise Blocked("ADMIN_EFFECTIVE_POLICY_WOULD_CHANGE")
        print("ELITE_CANDIDATE_ADMIN_SSH_POLICY_UNCHANGED=PASS")
        for ip in CONTEXT_IPS:
            policy = parse_policy(run_sshd(temp.name, UPLOADER, ip))
            if any(policy.get(k) != v for k, v in RESTRICTIONS.items()):
                raise Blocked("UPLOADER_CANDIDATE_NOT_FORCE_SFTP")
        print("ELITE_CANDIDATE_UPLOADER_RESTRICTED_POLICY=PASS")
    # Detect concurrent main config changes before claiming dry-run result.
    current, meta = inspect_preconditions()
    if (current != original or meta.st_ino != original_meta.st_ino or
            meta.st_dev != original_meta.st_dev or
            meta.st_mtime_ns != original_meta.st_mtime_ns):
        raise Blocked("LIVE_SSHD_CONFIG_CHANGED_DURING_CHECK")
    print("ELITE_SSHD_SFTP_CANDIDATE_DRY_RUN=PASS")
    print("ELITE_PRODUCTION_SSH_CONFIG_AND_SERVICE=UNMODIFIED")
    print("ELITE_UPLOADER_RESTRICTED_SFTP_INSTALL=NOT_ATTEMPTED")
    print("RELAY_TO_ELITE_AUTHENTICATED_LOGIN=NOT_ATTEMPTED")
    print("AGE_OWNER_RECOVERY_AND_BACKUP_RESTORE=NOT_VERIFIED")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")


def self_test():
    assert STANZA.count(b"Match User kmjcloudosbackup") == 1
    assert STANZA.endswith(b"PermitListen none\n")
    assert len(RESTRICTIONS) == 14
    for key, value in RESTRICTIONS.items():
        for duplicate in (value, "unsafe"):
            try:
                parse_policy(f"{key} {value}\n{key} {duplicate}\n".encode())
            except Blocked:
                pass
            else:
                raise AssertionError("Duplicate protected setting accepted")
    assert parse_policy(b"hostkey /one\nhostkey /two\n")["hostkey"] == "/one"
    print("ELITE_SSHD_SFTP_DRYRUN_OFFLINE_TESTS=PASS")


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:] != ["--dry-run"]:
        print("USAGE: script.py --dry-run | --self-test")
        return 64
    try:
        evaluate()
        return 0
    except (Blocked, UnicodeError) as error:
        print("ELITE_SSHD_SFTP_CANDIDATE_DRY_RUN=BLOCKED")
        print("ELITE_DRYRUN_BLOCKER=" + (
            str(error)[:90] if isinstance(error, Blocked) else "UNREADABLE_OUTPUT"))
        print("ELITE_PRODUCTION_SSH_CONFIG_AND_SERVICE=UNMODIFIED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
