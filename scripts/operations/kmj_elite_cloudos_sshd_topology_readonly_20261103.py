#!/usr/bin/env python3
"""Read-only KMJ-ELITE SSH configuration topology and effective-policy preflight.

Use only on exact KMJ-elite as root. Does not change sshd_config, users, keys,
services, firewall, backup vault, CloudOS tenants, or paid resources. Prints no
SSH/AGE keys, complete settings, credentials or config lines. Findings guide
a separate rollback-safe restricted SFTP policy installation.
"""
from __future__ import annotations

import os
import re
import stat
import subprocess
import sys

HOST = "kmj-elite"
SSHD = "/usr/sbin/sshd"
CONFIG = "sshd_config"
INCLUDED = "sshd_config.d"
EXPECTED_INCLUDE = "/etc/ssh/sshd_config.d/*.conf"
UPLOADER = "kmjcloudosbackup"
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
O_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
MAX_CONFIG = 65536
TARGET_CONFIG = {
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
}
# These two values may be reported as "any" by OpenSSH in its output. The
# policy installer will require additional fail-closed restrictions.
REQUIRED_FORBIDDEN = {
    "permitopen": "none",
    "permitlisten": "none",
}


class Blocked(RuntimeError):
    pass


def read_check(st, *, kind, mode=None):
    if st.st_uid != 0 or st.st_mode & 0o022:
        raise Blocked("UNTRUSTED_CONFIG_OWNER_OR_PERMISSIONS")
    if kind == "dir":
        if not stat.S_ISDIR(st.st_mode):
            raise Blocked("UNTRUSTED_DIRECTORY_TYPE")
    elif (not stat.S_ISREG(st.st_mode) or
          st.st_nlink != 1 or not 0 < st.st_size <= MAX_CONFIG):
        raise Blocked("UNTRUSTED_CONFIG_FILE_TYPE_OR_SIZE")
    if mode is not None and stat.S_IMODE(st.st_mode) != mode:
        raise Blocked("DIRECTORY_MODE_UNEXPECTED")


def read_fd(fd):
    st = os.fstat(fd)
    read_check(st, kind="file")
    buf = os.read(fd, MAX_CONFIG + 1)
    if len(buf) != st.st_size:
        raise Blocked("CONFIG_CHANGED_DURING_READ")
    try:
        return buf.decode("utf-8")
    except UnicodeError:
        raise Blocked("CONFIG_NOT_VALID_UTF8") from None


def inspect_files():
    """Read only owner-trusted SSHD config paths; never follow final symlinks."""
    fds = []
    try:
        root = os.open("/", O_DIR)
        fds.append(root)
        read_check(os.fstat(root), kind="dir")
        etc = os.open("etc", O_DIR, dir_fd=root)
        fds.append(etc)
        read_check(os.fstat(etc), kind="dir")
        ssh_dir = os.open("ssh", O_DIR, dir_fd=etc)
        fds.append(ssh_dir)
        read_check(os.fstat(ssh_dir), kind="dir")
        main = os.open(CONFIG, O_FILE, dir_fd=ssh_dir)
        fds.append(main)
        main_contents = read_fd(main)
        included = []
        try:
            dropins = os.open(INCLUDED, O_DIR, dir_fd=ssh_dir)
        except FileNotFoundError:
            dropins = None
        if dropins is not None:
            fds.append(dropins)
            read_check(os.fstat(dropins), kind="dir")
            names = sorted(os.listdir(dropins))
            if len(names) > 128:
                raise Blocked("SSHD_DROPIN_COUNT_EXCEEDED")
            for name in names:
                if not name.endswith(".conf"):
                    continue
                if "/" in name or name in (".", ".."):
                    raise Blocked("INVALID_SSHD_DROPIN")
                filefd = os.open(name, O_FILE, dir_fd=dropins)
                try:
                    included.append((name, read_fd(filefd)))
                finally:
                    os.close(filefd)
        return main_contents, included
    except OSError:
        raise Blocked("SSHD_CONFIG_TREE_NOT_VERIFIED") from None
    finally:
        for fd in reversed(fds):
            os.close(fd)


def directives(text):
    lines = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        values = stripped.split()
        if values:
            lines.append((values[0].lower(), values[1:]))
    return lines


def topology(main, dropins):
    lines = directives(main)
    includes = [i for i, (k, args) in enumerate(lines)
                if k == "include" and EXPECTED_INCLUDE in args]
    match_indices = [i for i, (k, _) in enumerate(lines) if k == "match"]
    in_global = bool(includes) and (
        not match_indices or min(includes) < min(match_indices))
    all_files = [("sshd_config", main)] + dropins
    match_blocks = sum(sum(1 for k, _ in directives(data) if k == "match")
                       for _, data in all_files)
    total_includes = sum(sum(1 for k, _ in directives(data) if k == "include")
                         for _, data in all_files)
    return {
        "dropin_include_global": in_global,
        "dropins": len(dropins),
        "match_blocks": match_blocks,
        "include_directives": total_includes,
    }


def run_checked(argv, seconds=12):
    try:
        proc = subprocess.run(
            argv, stdin=subprocess.DEVNULL, capture_output=True,
            timeout=seconds, text=True, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("SSHD_QUERY_UNAVAILABLE_OR_TIMEOUT") from None
    if proc.returncode or len(proc.stdout.encode("utf-8")) > 65536:
        raise Blocked("SSHD_QUERY_FAILED")
    return proc.stdout


def parse_effective(text):
    """Preserve SSHD's repeatable directives; never relax backup policy.

    OpenSSH -T may legitimately print several hostkey, acceptenv, port,
    listenaddress or similar multivalue directives. Their repetition is not
    a conflicting scalar setting. Every SFTP security-critical option is
    strictly single-valued: even two identical occurrences are rejected.
    Other options do not grant release credit and are advisory here only.
    """
    result = {}
    protected = frozenset(TARGET_CONFIG) | frozenset(REQUIRED_FORBIDDEN)
    for raw in text.splitlines():
        pair = raw.strip().split(None, 1)
        if len(pair) != 2:
            continue
        name, value = pair
        name = name.lower()
        if name in result:
            if name in protected:
                raise Blocked("SSHD_DUPLICATE_PROTECTED_EFFECTIVE_SETTING")
            # Non-policy multivalued attributes are permitted to repeat.
            # We do not use their arbitrarily selected value for a PASS.
            continue
        result[name] = value
    return result


def target_policy_status(effective):
    return (all(effective.get(k) == v for k, v in TARGET_CONFIG.items())
            and all(effective.get(k) == v
                    for k, v in REQUIRED_FORBIDDEN.items()))


def inspect():
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("EXACT_ELITE_ROOT_HOST_REQUIRED")
    main, dropins = inspect_files()
    summary = topology(main, dropins)
    print("ELITE_SSHD_CONFIG_TREE=ROOT_OWNED_NOFOLLOW_VERIFIED")
    print("ELITE_SSHD_GLOBAL_DROPIN_INCLUDE=" +
          ("PRESENT" if summary["dropin_include_global"]
           else "UNVERIFIED_OR_MISSING"))
    print("ELITE_SSHD_INCLUDED_CONF_COUNT=" + str(summary["dropins"]))
    print("ELITE_SSHD_MATCH_BLOCK_COUNT=" + str(summary["match_blocks"]))
    print("ELITE_SSHD_INCLUDE_DIRECTIVE_COUNT=" +
          str(summary["include_directives"]))

    run_checked([SSHD, "-t"])
    print("ELITE_SSHD_EXISTING_CONFIG_SYNTAX=PASS_READ_ONLY")

    def effective(user):
        return parse_effective(
            run_checked([SSHD, "-T", "-C",
                         f"user={user},host=relay,addr=127.0.0.1"]))

    admin = effective("root")
    backup = effective(UPLOADER)
    if not admin or not backup:
        raise Blocked("EFFECTIVE_CONFIG_NOT_AVAILABLE")
    print("ELITE_ADMIN_EFFECTIVE_POLICY=READ_ONLY_SNAPSHOT_PRESENT")
    print("ELITE_UPLOADER_EFFECTIVE_POLICY=READ_ONLY_SNAPSHOT_PRESENT")
    print("ELITE_UPLOADER_SFTP_POLICY=" +
          ("STATIC_MATCHES_EXPECTED" if target_policy_status(backup)
           else "NOT_YET_RESTRICTED_OR_POLICY_CONFLICT"))
    print("ELITE_ADMIN_POLICY_NOT_MODIFIED=PASS")
    print("ELITE_SSHD_SERVICE_OR_PORT_MUTATIONS=NONE_BY_THIS_PROGRAM")
    print("ELITE_AUTHENTICATED_UPLOADER_LOGIN=NOT_ATTEMPTED")
    print("ELITE_OWNER_AGE_RECOVERY=NOT_VERIFIED")
    print("ENCRYPTED_BACKUP_AND_RESTORE=NOT_ATTEMPTED")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
    print("ELITE_SSHD_TOPOLOGY_PREFLIGHT=READ_ONLY_COMPLETE")


def self_test():
    expected = [
        "Include /etc/ssh/sshd_config.d/*.conf",
        "PasswordAuthentication yes",
        "Match User other",
        "  PasswordAuthentication no",
    ]
    s = "\n".join(expected)
    assert topology(s, [("01-base.conf", "PermitRootLogin prohibit-password\n")])[
        "dropin_include_global"]
    assert not topology("Match User other\nInclude " + EXPECTED_INCLUDE, [])[
        "dropin_include_global"]
    assert not topology("PasswordAuthentication yes\n", [])[
        "dropin_include_global"]
    assert directives("  # comment\nPasswordAuthentication no\n")[0] == (
        "passwordauthentication", ["no"])
    assert target_policy_status({**TARGET_CONFIG, **REQUIRED_FORBIDDEN})
    # sshd -T commonly emits repeated hostkey / acceptenv / port lines.
    benign = ("hostkey /etc/ssh/ssh_host_ed25519_key\n"
              "hostkey /etc/ssh/ssh_host_rsa_key\n"
              "acceptenv LANG\nacceptenv LC_*\n"
              "port 22\nport 2222\n"
              "listenaddress 0.0.0.0:22\nlistenaddress [::]:22\n")
    vals = parse_effective(benign)
    assert vals["hostkey"] == "/etc/ssh/ssh_host_ed25519_key"
    assert vals["acceptenv"] == "LANG"
    assert vals["port"] == "22"
    assert vals["listenaddress"] == "0.0.0.0:22"
    assert target_policy_status(parse_effective(
        benign + "".join(f"{k} {v}\n"
                         for k, v in {**TARGET_CONFIG,
                                      **REQUIRED_FORBIDDEN}.items())))
    for setting in TARGET_CONFIG.keys() | REQUIRED_FORBIDDEN.keys():
        good = TARGET_CONFIG.get(setting, REQUIRED_FORBIDDEN.get(setting))
        for duplicate in (good, "untrusted"):
            try:
                parse_effective(f"{setting} {good}\n{setting} {duplicate}\n")
            except Blocked:
                pass
            else:
                raise AssertionError("Duplicate protected SSHD setting accepted")
    for setting in ("forcecommand", "chrootdirectory",
                    "passwordauthentication", "authorizedkeysfile"):
        bad = {**TARGET_CONFIG, **REQUIRED_FORBIDDEN}
        bad[setting] = "unsafe"
        assert not target_policy_status(bad)
    print("ELITE_SSHD_TOPOLOGY_OFFLINE_TESTS=PASS")


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
        print("ELITE_SSHD_TOPOLOGY_PREFLIGHT=BLOCKED")
        print("ELITE_TOPOLOGY_REASON=" + str(exc)[:90])
        print("ELITE_SSHD_SERVICE_OR_PORT_MUTATIONS=NONE_BY_THIS_PROGRAM")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
