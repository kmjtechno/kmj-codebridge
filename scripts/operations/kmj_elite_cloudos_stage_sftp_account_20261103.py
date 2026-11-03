#!/usr/bin/env python3
"""Guarded one-time SFTP *account and directory staging*, NOT backup activation.

Exact host: root on KMJ-elite. No SSH configuration, public/private key, AGE
recipient, network, VM, service, credential, vault-content or backup changes.
New login principal gets nologin shell and NO password or authorized key.
No role escalation and no cleanup of any pre-existing account or directory.

A failed partial stage must be audited and rerun idempotently; never delete
users/files automatically. An independently verified SSH Match policy and
owner-controlled AGE recovery are separate future release prerequisites.
"""
from __future__ import annotations

import grp
import os
import pwd
import stat
import subprocess
import sys

HOST = "kmj-elite"
ACCOUNT = "kmjcloudosbackup"
SFTP_DIR = "kmj-cloudos-n2-sftp"
VAULT_DIR = "kmj-cloudos-n2-offsite"
INCOMING_DIR = "incoming"
NOLOGIN = "/usr/sbin/nologin"
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
BANNED_GROUPS = frozenset({
    "sudo", "adm", "docker", "lxd", "libvirt", "wheel",
    "systemd-journal", "root",
})


class Blocked(RuntimeError):
    """Fixed error codes only; never include local account or file contents."""


def require_dir(st, *, uid=0, mode=None, strict=False):
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid:
        raise Blocked("UNSAFE_DIRECTORY_OWNER_OR_TYPE")
    real_mode = stat.S_IMODE(st.st_mode)
    if mode is not None and real_mode != mode:
        raise Blocked("DIRECTORY_MODE_NOT_ALLOWED")
    if strict and real_mode & 0o022:
        raise Blocked("DIRECTORY_WRITABLE_BY_GROUP_OR_WORLD")


def require_disabled_local_shadow():
    """Verify the account has no usable password without printing hashes.

    This stage requires a local shadow account. Unknown NSS/LDAP identities
    must not be adopted as an isolated backup principal.
    """
    try:
        fd = os.open("/etc/shadow", FILE_FLAGS)
        try:
            st = os.fstat(fd)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or
                    st.st_mode & 0o022 or st.st_size > 1024 * 1024 or
                    st.st_size < 20):
                raise Blocked("LOCAL_SHADOW_FILE_UNSAFE")
            payload = os.read(fd, st.st_size + 1)
            if len(payload) != st.st_size:
                raise Blocked("LOCAL_SHADOW_CHANGED_DURING_READ")
        finally:
            os.close(fd)
    except OSError:
        raise Blocked("LOCAL_SHADOW_NOT_READABLE") from None
    prefix = ACCOUNT.encode("ascii") + b":"
    matches = [line.split(b":", 2)[1]
               for line in payload.splitlines()
               if line.startswith(prefix) and b":" in line[len(prefix):]]
    if len(matches) != 1 or not matches[0].startswith((b"!", b"*")):
        raise Blocked("UPLOADER_PASSWORD_NOT_LOCKED_OR_LOCAL")


def account_status():
    """Return None if absent; reject privileged/inconsistent existing users."""
    try:
        u = pwd.getpwnam(ACCOUNT)
    except KeyError:
        return None
    if (u.pw_uid < 1000 or u.pw_gid < 1000 or
            u.pw_shell != NOLOGIN or
            u.pw_dir != "/nonexistent"):
        raise Blocked("EXISTING_UPLOADER_IDENTITY_UNSAFE")
    try:
        primary = grp.getgrgid(u.pw_gid)
        groups = {grp.getgrgid(i).gr_name
                  for i in os.getgrouplist(ACCOUNT, u.pw_gid)}
    except (KeyError, OSError):
        raise Blocked("UPLOADER_GROUP_LOOKUP_FAILED") from None
    if primary.gr_name != ACCOUNT or groups != {ACCOUNT} or groups & BANNED_GROUPS:
        raise Blocked("UPLOADER_GROUP_SCOPE_UNSAFE")
    require_disabled_local_shadow()
    return u


def open_root_srv():
    root = os.open("/", DIR_FLAGS)
    try:
        require_dir(os.fstat(root), uid=0, strict=True)
        srv = os.open("srv", DIR_FLAGS, dir_fd=root)
        try:
            require_dir(os.fstat(srv), uid=0, strict=True)
            if os.fstat(root).st_dev != os.fstat(srv).st_dev:
                raise Blocked("UNEXPECTED_SRV_MOUNT")
            vault = os.open(VAULT_DIR, DIR_FLAGS, dir_fd=srv)
            try:
                require_dir(os.fstat(vault), uid=0, mode=0o700)
                if os.fstat(srv).st_dev != os.fstat(vault).st_dev:
                    raise Blocked("PROTECTED_VAULT_MOUNT_UNVERIFIED")
            finally:
                os.close(vault)
            return srv
        except BaseException:
            os.close(srv)
            raise
    finally:
        os.close(root)


def open_optional_dir(parent_fd, name, *, owner, mode):
    try:
        fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        return None
    try:
        st = os.fstat(fd)
        require_dir(st, uid=owner, mode=mode)
        if st.st_dev != os.fstat(parent_fd).st_dev:
            raise Blocked("UNEXPECTED_STAGED_DIRECTORY_MOUNT")
        return fd
    except BaseException:
        os.close(fd)
        raise


def preflight(srv):
    user = account_status()
    chroot = open_optional_dir(srv, SFTP_DIR, owner=0, mode=0o755)
    try:
        if chroot is not None:
            contents = os.listdir(chroot)
            if any(name != INCOMING_DIR for name in contents):
                raise Blocked("UNEXPECTED_CHROOT_CONTENTS")
            if contents:
                if user is None:
                    raise Blocked("EXISTING_SPOOL_WITHOUT_UPLOADER")
                incoming = open_optional_dir(chroot, INCOMING_DIR,
                                             owner=user.pw_uid, mode=0o700)
                if incoming is None:
                    raise Blocked("UNEXPECTED_MISSING_UPLOAD_SPOOL")
                os.close(incoming)
        print("ELITE_PROTECTED_ROOT_VAULT=PASS", flush=True)
        print("ELITE_UPLOADER_ACCOUNT=" +
              ("EXISTING_SAFE" if user is not None else "TO_CREATE"), flush=True)
        print("ELITE_ROOT_CHROOT=" +
              ("EXISTING_SAFE" if chroot is not None else "TO_CREATE"), flush=True)
        print("ELITE_SFTP_ACCOUNT_STAGE_PREFLIGHT=PASS", flush=True)
        return user
    finally:
        if chroot is not None:
            os.close(chroot)


def add_account():
    # Never overwrite an existing account, and never run an arbitrary shell.
    try:
        proc = subprocess.run(
            ["/usr/sbin/useradd", "--no-create-home", "--user-group",
             "--home-dir", "/nonexistent", "--shell", NOLOGIN,
             "--comment", "KMJ CloudOS isolated SFTP backup uploader",
             ACCOUNT],
            stdin=subprocess.DEVNULL, capture_output=True,
            text=True, check=False, timeout=25,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("UPLOADER_USERADD_UNAVAILABLE") from None
    if proc.returncode != 0:
        raise Blocked("UPLOADER_USERADD_FAILED_RECHECK_STATE")
    user = account_status()
    if user is None:
        raise Blocked("CREATED_UPLOADER_IDENTITY_UNVERIFIED")
    return user


def stage(srv, user):
    # A new account has no password or authorized public key installed by
    # this script. Do not change the actual sshd configuration here.
    if user is None:
        user = add_account()
        print("ELITE_UPLOADER_ACCOUNT=CREATED_NO_KEY_NO_SSH_POLICY", flush=True)
    else:
        print("ELITE_UPLOADER_ACCOUNT=EXISTING_SAFE_UNCHANGED", flush=True)

    chroot = open_optional_dir(srv, SFTP_DIR, owner=0, mode=0o755)
    if chroot is None:
        os.mkdir(SFTP_DIR, 0o700, dir_fd=srv)
        chroot = os.open(SFTP_DIR, DIR_FLAGS, dir_fd=srv)
        try:
            # Only chmod the directory created in *this exact invocation*.
            require_dir(os.fstat(chroot), uid=0, mode=0o700)
            os.fchmod(chroot, 0o755)
            require_dir(os.fstat(chroot), uid=0, mode=0o755)
        except BaseException:
            os.close(chroot)
            raise
        print("ELITE_SFTP_CHROOT=CREATED_ROOT_0755", flush=True)
    else:
        print("ELITE_SFTP_CHROOT=EXISTING_SAFE_UNCHANGED", flush=True)

    try:
        current = os.listdir(chroot)
        if any(name != INCOMING_DIR for name in current):
            raise Blocked("CHROOT_UNEXPECTED_CONTENTS_POSTCREATE")
        incoming = open_optional_dir(chroot, INCOMING_DIR,
                                     owner=user.pw_uid, mode=0o700)
        if incoming is None:
            os.mkdir(INCOMING_DIR, 0o700, dir_fd=chroot)
            incoming = os.open(INCOMING_DIR, DIR_FLAGS, dir_fd=chroot)
            try:
                require_dir(os.fstat(incoming), uid=0, mode=0o700)
                os.fchown(incoming, user.pw_uid, user.pw_gid)
                require_dir(os.fstat(incoming), uid=user.pw_uid, mode=0o700)
                print("ELITE_SFTP_UPLOAD_SPOOL=CREATED_OWNER_0700", flush=True)
            finally:
                os.close(incoming)
        else:
            os.close(incoming)
            print("ELITE_SFTP_UPLOAD_SPOOL=EXISTING_SAFE_UNCHANGED", flush=True)
    finally:
        os.close(chroot)

    # No account login activated. All credential and restore gates are separate.
    print("ELITE_STAGE_ACCOUNT_CHROOT_SPOOL=PASS", flush=True)
    print("ELITE_SSHD_CONFIGURATION=UNTOUCHED", flush=True)
    print("ELITE_AUTHORIZED_PUBLIC_KEY=NOT_INSTALLED_BY_THIS_SCRIPT", flush=True)
    print("ELITE_AGE_OWNER_RECOVERY=NOT_CONFIGURED", flush=True)
    print("ELITE_ENCRYPTED_BACKUP_TRANSFER=NOT_ATTEMPTED", flush=True)
    print("INDEPENDENT_RESTORE_AND_ROLLBACK=NOT_VERIFIED", flush=True)
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)


def self_test():
    from types import SimpleNamespace
    d = lambda uid, mode: SimpleNamespace(
        st_uid=uid, st_mode=stat.S_IFDIR | mode)
    require_dir(d(0, 0o700), uid=0, mode=0o700)
    require_dir(d(0, 0o755), uid=0, mode=0o755)
    for uid, mode in ((1001, 0o755), (0, 0o777),
                      (0, 0o750), (0, 0o700)):
        try:
            require_dir(d(uid, mode), uid=0, mode=0o755)
        except Blocked:
            pass
        else:
            raise AssertionError("Unsafe chroot directory accepted")
    assert ACCOUNT == "kmjcloudosbackup"
    assert SFTP_DIR != VAULT_DIR and INCOMING_DIR == "incoming"
    assert NOLOGIN == "/usr/sbin/nologin"
    print("ELITE_SFTP_STAGE_OFFLINE_TESTS=PASS")


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:] not in (["--inspect"], ["--stage"]):
        print("USAGE: script.py --inspect | --stage | --self-test")
        return 64
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        print("ELITE_SFTP_STAGE=BLOCKED_EXACT_HOST_AND_ROOT_REQUIRED")
        return 2
    srv = None
    try:
        os.umask(0o077)
        srv = open_root_srv()
        user = preflight(srv)
        if sys.argv[1:] == ["--inspect"]:
            print("ELITE_SFTP_STAGE=READ_ONLY_PREFLIGHT_ONLY")
        else:
            stage(srv, user)
        return 0
    except (Blocked, OSError) as exc:
        # Never echo system command stderr, shadow data, public keys or paths.
        print("ELITE_SFTP_STAGE=BLOCKED")
        print("ELITE_STAGE_REASON=" +
              (str(exc)[:100] if isinstance(exc, Blocked)
               else "FILESYSTEM_OPERATION_FAILED"))
        print("ELITE_PARTIAL_STAGE=RECHECK_BEFORE_RETRY")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2
    finally:
        if srv is not None:
            os.close(srv)


if __name__ == "__main__":
    raise SystemExit(main())
