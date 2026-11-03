#!/usr/bin/env python3
"""Prepare one dedicated CloudOS SFTP uploader ED25519 identity on the existing GCE relay.

This script never makes an SSH connection, contacts ELITE, or installs any
authorization remotely. Exact GCE metadata and nonroot operator required.
Private key remains in this relay user's own ~/.ssh, never printed or sent.
--inspect is read-only. --create creates key files only if both absent.
The public key line and SHA256 fingerprint are safe to copy for onboarding.
"""
from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import urllib.request

PROJECT = "kmj-techno"
ZONE = "us-central1-a"
VM = "instance-20260912-094732"
INTERNAL_IP = "10.128.0.2"
KEYNAME = "kmj-cloudos-n2-sftp-ed25519"
COMMENT = "kmj-cloudos-n2-relay-sftp"
KEYTYPE = "ssh-ed25519"
ENCODED = re.compile(r"[A-Za-z0-9+/]+={0,2}\Z")
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
O_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC


class Blocked(RuntimeError):
    pass


def metadata(resource):
    if resource not in (
        "instance/name",
        "instance/zone",
        "project/project-id",
        "instance/network-interfaces/0/ip",
    ):
        raise Blocked("METADATA_RESOURCE_NOT_ALLOWED")
    req = urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/" + resource,
        headers={"Metadata-Flavor": "Google"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=5) as resp:
            if resp.headers.get("Metadata-Flavor") != "Google":
                raise Blocked("METADATA_RESPONSE_NOT_TRUSTED")
            raw = resp.read(257)
    except (OSError, TimeoutError):
        raise Blocked("RELAY_METADATA_UNAVAILABLE") from None
    if not 1 <= len(raw) <= 256:
        raise Blocked("RELAY_METADATA_SIZE_INVALID")
    return raw.decode("ascii", "strict").strip()


def check_relay():
    if os.geteuid() == 0:
        raise Blocked("RELAY_NONROOT_USER_REQUIRED")
    if (metadata("instance/name") != VM
            or metadata("project/project-id") != PROJECT
            or not metadata("instance/zone").endswith("/" + ZONE)
            or metadata("instance/network-interfaces/0/ip") != INTERNAL_IP):
        raise Blocked("EXACT_GCE_RELAY_IDENTITY_MISMATCH")
    account = pwd.getpwuid(os.geteuid())
    root = Path(account.pw_dir)
    s = root.lstat()
    if (not stat.S_ISDIR(s.st_mode) or s.st_uid != os.geteuid()
            or (s.st_mode & 0o022)):
        raise Blocked("RELAY_HOME_UNTRUSTED")
    return root


def ssh_dir(root, create):
    path = root / ".ssh"
    try:
        s = path.lstat()
    except FileNotFoundError:
        if not create:
            return None
        path.mkdir(mode=0o700)
        s = path.lstat()
    if (not stat.S_ISDIR(s.st_mode) or s.st_uid != os.geteuid()
            or stat.S_IMODE(s.st_mode) != 0o700):
        raise Blocked("RELAY_SSH_DIR_OWNERSHIP_OR_MODE_INVALID")
    return path


def inspect_file(path, private):
    fd = os.open(str(path), O_FILE)
    try:
        s = os.fstat(fd)
        if (not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid()
                or s.st_nlink != 1 or s.st_mode & 0o022 or
                not 40 <= s.st_size <= (8192 if private else 2048)):
            raise Blocked("UNTRUSTED_KEY_FILE")
        if private and stat.S_IMODE(s.st_mode) != 0o600:
            raise Blocked("PRIVATE_KEY_PERMISSIONS_NOT_0600")
        if private:
            return None
        raw = os.read(fd, 2049)
        if len(raw) != s.st_size:
            raise Blocked("PUBLIC_KEY_CHANGED_DURING_READ")
        return raw.decode("ascii", "strict").strip()
    finally:
        os.close(fd)


def parse_public(line):
    fields = line.strip().split()
    if len(fields) not in (2, 3) or fields[0] != KEYTYPE:
        raise Blocked("PUBLIC_KEY_TYPE_OR_FIELDS_INVALID")
    if len(fields[1]) > 512 or not ENCODED.fullmatch(fields[1]):
        raise Blocked("PUBLIC_KEY_BASE64_INVALID")
    try:
        raw = base64.b64decode(fields[1], validate=True)
    except ValueError:
        raise Blocked("PUBLIC_KEY_ENCODING_INVALID") from None
    if len(raw) != 51 or raw[:15] != b"\x00\x00\x00\x0bssh-ed25519" or raw[15:19] != b"\x00\x00\x00\x20":
        raise Blocked("ED25519_PUBLIC_BLOB_INVALID")
    if len(fields) == 3 and (len(fields[2]) > 96
                             or any(ord(c) < 33 or ord(c) > 126 for c in fields[2])):
        raise Blocked("PUBLIC_KEY_COMMENT_INVALID")
    fingerprint = "SHA256:" + base64.b64encode(
        hashlib.sha256(raw).digest()).decode("ascii").rstrip("=")
    return fields[0] + " " + fields[1] + " " + COMMENT, fingerprint


def verify_pair(directory):
    private = directory / KEYNAME
    public = directory / (KEYNAME + ".pub")
    inspect_file(private, private=True)
    line = inspect_file(public, private=False)
    normalized, fp = parse_public(line)
    try:
        result = subprocess.run(
            ["/usr/bin/ssh-keygen", "-y", "-P", "", "-f", str(private)],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=12, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("RELAY_PRIVATE_KEY_PUBLIC_DERIVATION_FAILED") from None
    if result.returncode or len(result.stdout) > 2048:
        raise Blocked("RELAY_PRIVATE_PUBLIC_PAIR_MISMATCH")
    derived, _ = parse_public(result.stdout.decode("ascii", "strict").strip())
    if derived.split()[:2] != normalized.split()[:2]:
        raise Blocked("RELAY_PRIVATE_PUBLIC_PAIR_MISMATCH")
    print("RELAY_DEDICATED_SFTP_IDENTITY=PRIVATE_PUBLIC_PAIR_VERIFIED")
    print("RELAY_SFTP_PUBLIC_FINGERPRINT=" + fp)
    print("RELAY_SFTP_PUBLIC_KEY=" + normalized)
    print("RELAY_SFTP_PRIVATE_KEY=RETAINED_LOCALLY_NEVER_EXPORTED")
    print("ELITE_SFTP_AUTHORIZATION=NOT_ATTEMPTED")
    print("RELAY_TO_ELITE_AUTHENTICATED_SFTP=NOT_ATTEMPTED")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")


def main():
    if sys.argv[1:] == ["--self-test"]:
        sample = base64.b64encode(
            b"\x00\x00\x00\x0bssh-ed25519" + b"\x00\x00\x00\x20" +
            bytes(range(32))).decode("ascii")
        key, fp = parse_public("ssh-ed25519 " + sample + " example")
        assert key.endswith(COMMENT)
        assert fp.startswith("SHA256:") and len(fp) == 50
        for text in ("ssh-rsa " + sample, "ssh-ed25519 ***", "ssh-ed25519 Zm9v"):
            try:
                parse_public(text)
            except Blocked:
                pass
            else:
                raise AssertionError("Unsafe key accepted")
        print("RELAY_DEDICATED_SFTP_IDENTITY_OFFLINE_TESTS=PASS")
        return 0
    if sys.argv[1:] not in (["--inspect"], ["--create"]):
        print("USAGE: script.py --self-test | --inspect | --create")
        return 64
    try:
        root = check_relay()
        create = sys.argv[1:] == ["--create"]
        folder = ssh_dir(root, create)
        print("RELAY_EXACT_GCE_METADATA=PASS")
        if folder is None:
            print("RELAY_DEDICATED_SFTP_IDENTITY=ABSENT")
            return 0
        key, pub = folder / KEYNAME, folder / (KEYNAME + ".pub")
        exists = key.exists() or key.is_symlink() or pub.exists() or pub.is_symlink()
        if not exists and not create:
            print("RELAY_DEDICATED_SFTP_IDENTITY=ABSENT")
            return 0
        if not exists and create:
            result = subprocess.run(
                ["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-a", "100",
                 "-N", "", "-C", COMMENT, "-f", str(key)],
                stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
                check=False,
            )
            if result.returncode:
                raise Blocked("DEDICATED_SFTP_KEY_CREATION_FAILED")
            print("RELAY_DEDICATED_SFTP_IDENTITY=CREATED_PRIVATE_LOCAL")
        verify_pair(folder)
        return 0
    except (Blocked, OSError, UnicodeError) as exc:
        print("RELAY_DEDICATED_SFTP_IDENTITY=BLOCKED")
        print("RELAY_IDENTITY_REASON=" +
              (str(exc)[:85] if isinstance(exc, Blocked)
               else "LOCAL_FILESYSTEM_OR_OUTPUT_UNAVAILABLE"))
        print("RELAY_TO_ELITE_AUTHENTICATED_SFTP=NOT_ATTEMPTED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
