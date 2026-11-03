#!/usr/bin/env python3
"""Read-only, fail-closed ELITE CloudOS offsite-receiver readiness audit.

No user/key/account generation, chmod, sshd reload, backup transfer, remote
login, cloud resource mutation, or AGE decryption. The two paths below separate
a future untrusted upload spool from the existing root-only backup vault.

This audits sshd -T with a *simulated* local connection context. The live
relay source IP and real login still require independent verification.
"""
from __future__ import annotations

import base64
import binascii
import grp
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys

HOST = "kmj-elite"
ACCOUNT = "kmjcloudosbackup"
VAULT = "/srv/kmj-cloudos-n2-offsite"
CHROOT = "/srv/kmj-cloudos-n2-sftp"
INCOMING = CHROOT + "/incoming"
AUTHORIZED = "/etc/ssh/authorized_keys/" + ACCOUNT
RECIPIENT = "/etc/kmj-cloudos-backup/owner-recipient.txt"
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
AGE_PUBLIC = re.compile(r"age1[023456789acdefghjklmnpqrstuvwxyz]{58}\Z")
BANNED_GROUPS = frozenset({
    "sudo", "adm", "docker", "lxd", "libvirt", "wheel", "systemd-journal",
})
EXPECTED = {
    "chrootdirectory": CHROOT,
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
}
# This key path is *root-owned* and contains public keys only. No authorized
# private key or any AGE secret may ever be printed or sent to a source repo.
EXPECTED_AUTH_KEYS = "/etc/ssh/authorized_keys/%u"


class Blocked(RuntimeError):
    pass


def require_dir(st, owner, *, mode=None):
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != owner:
        raise Blocked("UNTRUSTED_DIRECTORY_OWNER_OR_TYPE")
    actual_mode = stat.S_IMODE(st.st_mode)
    if mode is not None and actual_mode != mode:
        raise Blocked("DIRECTORY_MODE_MISMATCH")
    if actual_mode & 0o022:
        raise Blocked("GROUP_OR_WORLD_WRITABLE_DIRECTORY")


def directory_info(path: str):
    """No-follow every component, including trusted root ancestors."""
    parts = Path(path).parts
    if not parts or parts[0] != "/" or any(x in (".", "..") for x in parts):
        raise Blocked("INVALID_ABSOLUTE_PATH")
    fds = []
    try:
        fds.append(os.open("/", DIR_FLAGS))
        require_dir(os.fstat(fds[-1]), 0)
        for part in parts[1:]:
            fds.append(os.open(part, DIR_FLAGS, dir_fd=fds[-1]))
            require_dir(os.fstat(fds[-1]), 0 if part != "incoming" else -1)
        return os.fstat(fds[-1])
    except OSError as exc:
        raise Blocked("DIRECTORY_MISSING_OR_UNSAFE") from exc
    finally:
        for fd in reversed(fds):
            os.close(fd)


def read_root_file(path: str, max_bytes: int = 2048) -> str:
    parent, basename = os.path.split(path)
    if not basename or basename in (".", ".."):
        raise Blocked("INVALID_FILE_NAME")
    parts = Path(parent).parts
    fds = []
    try:
        fds.append(os.open("/", DIR_FLAGS))
        require_dir(os.fstat(fds[-1]), 0)
        for part in parts[1:]:
            fds.append(os.open(part, DIR_FLAGS, dir_fd=fds[-1]))
            require_dir(os.fstat(fds[-1]), 0)
        fds.append(os.open(basename, FILE_FLAGS, dir_fd=fds[-1]))
        info = os.fstat(fds[-1])
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                stat.S_IMODE(info.st_mode) != 0o600 or
                not 1 <= info.st_size <= max_bytes or info.st_nlink != 1):
            raise Blocked("UNSAFE_ROOT_MANAGED_FILE")
        data = os.read(fds[-1], max_bytes + 1)
        if len(data) != info.st_size or len(data) > max_bytes:
            raise Blocked("ROOT_FILE_CHANGED_OR_OVERSIZE")
        return data.decode("ascii")
    except (OSError, UnicodeError) as exc:
        raise Blocked("ROOT_MANAGED_FILE_MISSING_OR_UNSAFE") from exc
    finally:
        for fd in reversed(fds):
            os.close(fd)


def valid_authorized_ed25519(text: str) -> bool:
    lines = text.splitlines()
    if len(lines) != 1:
        return False
    fields = lines[0].strip().split()
    if len(fields) not in (2, 3) or fields[0] != "ssh-ed25519":
        return False
    try:
        key = base64.b64decode(fields[1], validate=True)
    except (ValueError, binascii.Error):
        return False
    # SSH public-key wire encoding: string "ssh-ed25519", string 32-byte key.
    return (len(key) == 51 and
            key[:4] == (11).to_bytes(4, "big") and
            key[4:15] == b"ssh-ed25519" and
            key[15:19] == (32).to_bytes(4, "big"))


def valid_age_recipient(text: str) -> bool:
    # Public recipient only. This does NOT prove the owner can recover
    # the corresponding private identity from an independent machine.
    return len(text.splitlines()) == 1 and AGE_PUBLIC.fullmatch(text.strip()) is not None


def parse_sshd_effective(text: str) -> bool:
    settings = {}
    if len(text.encode("utf-8")) > 32768:
        return False
    for line in text.splitlines():
        row = line.strip().lower().split(None, 1)
        if len(row) != 2:
            continue
        key, value = row
        if key in settings and settings[key] != value:
            return False
        settings[key] = value
    return (all(settings.get(k) == v for k, v in EXPECTED.items())
            and settings.get("authorizedkeysfile") == EXPECTED_AUTH_KEYS
            and settings.get("permitopen", "none") == "none"
            and settings.get("permitlisten", "none") == "none")


def identity_check():
    try:
        user = pwd.getpwnam(ACCOUNT)
        if (user.pw_uid < 1000 or user.pw_gid < 1000 or
                user.pw_shell not in ("/usr/sbin/nologin", "/bin/false")):
            raise Blocked("UPLOADER_ACCOUNT_NOT_LEAST_PRIVILEGED")
        groups = {
            grp.getgrgid(gid).gr_name
            for gid in os.getgrouplist(ACCOUNT, user.pw_gid)
        }
        if groups & BANNED_GROUPS or len(groups) > 4:
            raise Blocked("UPLOADER_GROUP_MEMBERSHIP_UNSAFE")
        return user.pw_uid
    except (KeyError, OSError):
        raise Blocked("UPLOADER_ACCOUNT_MISSING_OR_UNVERIFIED") from None


def probe(label, fn):
    """Report every independent receiver prerequisite, never credit partial."""
    try:
        fn()
    except Blocked as exc:
        # Error codes contain no public-key material, credentials or paths.
        print(label + "=BLOCKED_" + str(exc)[:80], flush=True)
        return False
    print(label + "=PASS", flush=True)
    return True


def inspect():
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("EXACT_ELITE_ROOT_SESSION_REQUIRED")

    # Inspect independent controls in one bounded read-only pass. Do not
    # require a second root invocation merely because the account is absent.
    account = {}
    checks = []

    def check_vault():
        require_dir(directory_info("/srv"), 0)
        require_dir(directory_info(VAULT), 0, mode=0o700)

    checks.append(probe("ELITE_ROOT_ONLY_BACKUP_VAULT", check_vault))

    def check_account():
        account["uid"] = identity_check()

    checks.append(probe("ELITE_RESTRICTED_UPLOADER_IDENTITY", check_account))

    def check_chroot():
        require_dir(directory_info(CHROOT), 0, mode=0o755)

    chroot_ok = probe("ELITE_ROOT_OWNED_SFTP_CHROOT", check_chroot)
    checks.append(chroot_ok)

    def check_spool():
        if "uid" not in account:
            raise Blocked("UPLOADER_ACCOUNT_NOT_VERIFIED")
        if not chroot_ok:
            raise Blocked("SFTP_CHROOT_NOT_VERIFIED")
        require_dir(directory_info_allow_incoming(account["uid"]),
                    account["uid"], mode=0o700)

    checks.append(probe("ELITE_ISOLATED_UPLOAD_SPOOL", check_spool))

    def check_policy():
        if "uid" not in account:
            raise Blocked("UPLOADER_ACCOUNT_NOT_VERIFIED")
        try:
            result = subprocess.run(
                ["/usr/sbin/sshd", "-T", "-C",
                 f"user={ACCOUNT},host=relay,addr=127.0.0.1"],
                capture_output=True, text=True, timeout=10,
                check=False, stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Blocked("SSHD_POLICY_READ_UNAVAILABLE") from exc
        if result.returncode or not parse_sshd_effective(result.stdout):
            raise Blocked("RESTRICTED_SFTP_POLICY_UNVERIFIED")

    checks.append(probe("ELITE_SFTP_POLICY_SIMULATED_ONLY", check_policy))

    def check_public_key():
        if not valid_authorized_ed25519(read_root_file(AUTHORIZED)):
            raise Blocked("AUTHORIZED_PUBLIC_KEY_SYNTAX_UNVERIFIED")

    checks.append(probe("ELITE_ROOT_MANAGED_AUTHORIZED_PUBLIC_KEY_SYNTAX",
                        check_public_key))

    def check_public_age():
        if not valid_age_recipient(read_root_file(RECIPIENT)):
            raise Blocked("AGE_RECIPIENT_SYNTAX_UNVERIFIED")

    checks.append(probe("ELITE_AGE_PUBLIC_RECIPIENT_SYNTAX", check_public_age))

    print("RELAY_TO_ELITE_AUTHENTICATED_LOGIN=NOT_ATTEMPTED")
    print("AGE_OWNER_PRIVATE_RECOVERY_ESCROW=NOT_VERIFIED")
    print("CONSISTENT_ENCRYPTED_N2_BOOT_DISK_TRANSFER=NOT_ATTEMPTED")
    print("INDEPENDENT_DISPOSABLE_RESTORE_ROLLBACK=NOT_VERIFIED")
    print("ELITE_CONFIG_OR_HOST_MUTATIONS=NONE_BY_THIS_PROGRAM")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")

    if all(checks):
        print("ELITE_RECEIVER_STATIC_PREFLIGHT=PASS")
    else:
        raise Blocked("ONE_OR_MORE_RECEIVER_PREREQUISITES_MISSING")


def directory_info_allow_incoming(expected_uid: int):
    parts = Path(INCOMING).parts
    fds = []
    try:
        fds.append(os.open("/", DIR_FLAGS))
        require_dir(os.fstat(fds[-1]), 0)
        for part in parts[1:-1]:
            fds.append(os.open(part, DIR_FLAGS, dir_fd=fds[-1]))
            require_dir(os.fstat(fds[-1]), 0)
        fds.append(os.open(parts[-1], DIR_FLAGS, dir_fd=fds[-1]))
        result = os.fstat(fds[-1])
        require_dir(result, expected_uid, mode=0o700)
        return result
    except OSError as exc:
        raise Blocked("SFTP_INCOMING_SPOOL_MISSING_OR_UNSAFE") from exc
    finally:
        for fd in reversed(fds):
            os.close(fd)


def self_test():
    fake_key = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"x" * 32
    encoded = base64.b64encode(fake_key).decode("ascii")
    assert valid_authorized_ed25519("ssh-ed25519 " + encoded + " test\n")
    for bad in ("", "ssh-rsa " + encoded, "from=* ssh-ed25519 " + encoded,
                "ssh-ed25519 !!!", "ssh-ed25519 " + encoded + "\nssh-ed25519 " + encoded,
                "ssh-ed25519 " + base64.b64encode(b"x" * 32).decode("ascii")):
        assert not valid_authorized_ed25519(bad), bad[:25]
    base = "\n".join(f"{key} {value}" for key, value in EXPECTED.items())
    base += "\nauthorizedkeysfile " + EXPECTED_AUTH_KEYS + "\n"
    assert parse_sshd_effective(base)
    for bad in (
        base.replace("chrootdirectory " + CHROOT, "chrootdirectory /"),
        base.replace("forcecommand internal-sftp -d /incoming", "forcecommand none"),
        base.replace("passwordauthentication no", "passwordauthentication yes"),
        base.replace("allowtcpforwarding no", "allowtcpforwarding yes"),
        base.replace("authorizedkeysfile " + EXPECTED_AUTH_KEYS, "authorizedkeysfile .ssh/authorized_keys"),
    ):
        assert not parse_sshd_effective(bad)
    assert not valid_age_recipient("not-an-age-recipient\n")
    assert VAULT != CHROOT and CHROOT != INCOMING
    print("ELITE_RESTRICTED_RECEIVER_OFFLINE_TESTS=PASS")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:] != ["--inspect"]:
        print("USAGE: script.py --inspect or --self-test")
        return 64
    try:
        inspect()
        return 0
    except Blocked as exc:
        print("ELITE_RECEIVER_STATIC_PREFLIGHT=BLOCKED")
        print("ELITE_RECEIVER_BLOCKER=" + str(exc)[:100])
        print("ELITE_CONFIG_OR_HOST_MUTATIONS=NONE_BY_THIS_PROGRAM")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
