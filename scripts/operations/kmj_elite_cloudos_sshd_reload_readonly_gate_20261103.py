#!/usr/bin/env python3
"""Verify staged CloudOS SSHD SFTP policy BEFORE separately controlled reload.

Exact-host, root-only, strictly read-only apart from kernel processes of
sshd -t/-T and systemctl show. No daemon or configuration mutation, no key
disclosure, network login or backup transfer. This CANNOT prove that
existing live SSH sessions can reconnect after a later reload.
"""
from __future__ import annotations

import os
import pwd
import stat
import subprocess
import sys

HOST = "kmj-elite"
CONFIG = "/etc/ssh/sshd_config"
BACKUP = "/root/kmj-cloudos-sshd-before-sftp-20261103.conf"
SSHD = "/usr/sbin/sshd"
LIMIT = 65536
CONTEXTS = ("127.0.0.1", "10.128.0.2")
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
O_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
O_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC


class Blocked(RuntimeError):
    pass


def checked_directory(parent, name):
    fd = os.open(name, O_DIRECTORY, dir_fd=parent)
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        os.close(fd)
        raise Blocked("UNTRUSTED_DIRECTORY")
    return fd


def trusted_files():
    root = os.open("/", O_DIRECTORY)
    try:
        if os.fstat(root).st_uid != 0:
            raise Blocked("UNTRUSTED_FILESYSTEM_ROOT")
        etc = checked_directory(root, "etc")
        try:
            ssh = checked_directory(etc, "ssh")
            try:
                current = read_file(ssh, "sshd_config", backup=False)
            finally:
                os.close(ssh)
        finally:
            os.close(etc)
        private = checked_directory(root, "root")
        try:
            prior = read_file(private,
                              "kmj-cloudos-sshd-before-sftp-20261103.conf",
                              backup=True)
        finally:
            os.close(private)
    finally:
        os.close(root)
    return current, prior


def read_file(folder, basename, *, backup):
    fd = os.open(basename, O_FILE, dir_fd=folder)
    try:
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != 0
                or st.st_mode & 0o022 or st.st_nlink != 1
                or not 16 <= st.st_size <= LIMIT):
            raise Blocked("UNTRUSTED_SSHD_FILE")
        if backup and stat.S_IMODE(st.st_mode) != 0o600:
            raise Blocked("SSH_ORIGINAL_BACKUP_NOT_ROOT_0600")
        data = os.read(fd, LIMIT + 1)
        if len(data) != st.st_size:
            raise Blocked("SSH_FILE_CHANGED_DURING_READ")
        return data
    finally:
        os.close(fd)


def matches_exact_stage(current, prior):
    expected = prior + (b"" if prior.endswith(b"\n") else b"\n") + STANZA
    return current == expected


def run(argv):
    try:
        p = subprocess.run(argv, stdin=subprocess.DEVNULL,
                           capture_output=True, timeout=12, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("READ_ONLY_SSHD_OR_SYSTEMD_QUERY_FAILED") from None
    if p.returncode or len(p.stdout) > LIMIT:
        raise Blocked("READ_ONLY_QUERY_NONZERO_OR_OVERSIZE")
    return p.stdout


def effective(text):
    result = {}
    for row in text.decode("utf-8", "strict").splitlines():
        p = row.strip().split(None, 1)
        if len(p) != 2:
            continue
        k, v = p
        k = k.lower()
        if k in result and k in EXPECTED:
            raise Blocked("DUPLICATE_PROTECTED_SSHD_POLICY")
        if k not in result:
            result[k] = v
    return result


def query_config(config, user=None, addr="127.0.0.1"):
    args = [SSHD, "-t"] if user is None else [
        SSHD, "-T", "-C", f"user={user},host=relay,addr={addr}"
    ]
    args += ["-f", config]
    return run(args)


def ssh_service():
    data = run(["/usr/bin/systemctl", "show", "ssh.service",
                "--property=LoadState,ActiveState,CanReload,NeedDaemonReload,SubState"])
    fields = {}
    for row in data.decode("utf-8", "strict").splitlines():
        if "=" in row:
            key, value = row.split("=", 1)
            fields[key] = value.strip()
    if fields.get("LoadState") != "loaded" or fields.get("ActiveState") != "active":
        raise Blocked("SSH_SERVICE_NOT_ACTIVE_OR_LOADED")
    if fields.get("CanReload") != "yes":
        raise Blocked("SSH_SERVICE_RELOAD_NOT_ADVERTISED")
    if fields.get("NeedDaemonReload") not in ("no", ""):
        raise Blocked("SYSTEMD_DAEMON_RELOAD_PENDING")
    print("ELITE_SYSTEMD_SSH_SERVICE=ACTIVE_RELOAD_CAPABLE")


def validate():
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("EXACT_ELITE_ROOT_REQUIRED")
    current, backup = trusted_files()
    if not matches_exact_stage(current, backup):
        raise Blocked("STAGED_CONFIG_NOT_EXACTLY_ORIGINAL_PLUS_REVIEWED_MATCH")
    print("ELITE_SSHD_PROTECTED_ORIGINAL_AND_STAGED_CONTENT=EXACT_MATCH")
    # Both original and active-on-disk candidate syntax must pass.
    query_config(BACKUP)
    query_config(CONFIG)
    print("ELITE_SSHD_ORIGINAL_AND_STAGED_SYNTAX=PASS")
    admin_users = []
    for name in ADMINS:
        try:
            pwd.getpwnam(name)
        except KeyError:
            continue
        admin_users.append(name)
    if "root" not in admin_users or len(admin_users) < 2:
        raise Blocked("ADMIN_BASELINE_IDENTITIES_INSUFFICIENT")
    for addr in CONTEXTS:
        for name in admin_users:
            if query_config(BACKUP, name, addr) != query_config(CONFIG, name, addr):
                raise Blocked("ADMIN_POLICY_CHANGED_FROM_PROTECTED_ORIGINAL")
    print("ELITE_ADMIN_POLICY_PARITY_ORIGINAL_VS_STAGED=PASS")
    for addr in CONTEXTS:
        policy = effective(query_config(CONFIG, "kmjcloudosbackup", addr))
        if any(policy.get(k) != v for k, v in EXPECTED.items()):
            raise Blocked("RESTRICTED_SFTP_UPLOADER_EFFECTIVE_POLICY_MISMATCH")
    print("ELITE_RESTRICTED_SFTP_EFFECTIVE_POLICY=PASS_STAGED_ONLY")
    ssh_service()
    # Re-read content after tests to catch concurrent admin changes.
    latest, before = trusted_files()
    if latest != current or before != backup:
        raise Blocked("SSH_CONFIG_OR_BACKUP_CHANGED_DURING_PREFLIGHT")
    print("ELITE_SSHD_RELOAD_READINESS_PREFLIGHT=PASS")
    print("ELITE_SSHD_RELOAD=NOT_ATTEMPTED")
    print("ELITE_SSHD_PUBLIC_KEY_AUTHENTICATION=NOT_ATTEMPTED")
    print("ELITE_N2_AGE_RECOVERY_AND_RESTORE=NOT_VERIFIED")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")


def self_test():
    original = b"Include /etc/ssh/sshd_config.d/*.conf\n"
    expected = original + STANZA
    assert matches_exact_stage(expected, original)
    assert not matches_exact_stage(expected + b"\n", original)
    assert not matches_exact_stage(original, original)
    assert not matches_exact_stage(expected.replace(b"PermitTTY no", b"PermitTTY yes"), original)
    assert b"PermitUserEnvironment" not in STANZA
    assert EXPECTED["permituserenvironment"] == "no"
    test_policy = {**EXPECTED}
    assert all(test_policy.get(k) == v for k, v in EXPECTED.items())
    for k, v in EXPECTED.items():
        try:
            effective(f"{k} {v}\n{k} {v}\n".encode())
        except Blocked:
            pass
        else:
            raise AssertionError("Duplicate protected policy accepted")
    assert effective(b"hostkey /one\nhostkey /two\n")["hostkey"] == "/one"
    print("ELITE_SSHD_RELOAD_PREFLIGHT_OFFLINE_TESTS=PASS")


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:] != ["--inspect"]:
        print("USAGE: script.py --inspect | --self-test")
        return 64
    try:
        validate()
        return 0
    except (Blocked, OSError, UnicodeError) as err:
        print("ELITE_SSHD_RELOAD_READINESS_PREFLIGHT=BLOCKED")
        print("ELITE_READINESS_REASON=" +
              (str(err)[:90] if isinstance(err, Blocked)
               else "HOST_FILESYSTEM_OR_OUTPUT_UNAVAILABLE"))
        print("ELITE_SSHD_RELOAD=NOT_ATTEMPTED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
