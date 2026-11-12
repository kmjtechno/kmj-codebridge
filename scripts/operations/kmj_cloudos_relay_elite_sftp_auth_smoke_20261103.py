#!/usr/bin/env python3
"""Exact GCE-relay to ELITE ED25519 host-pinned authenticated SFTP smoke.

Only run as the existing nonroot operator on instance-20260912-094732.
--inspect verifies local identity + a freshly served, pre-pinned ELITE host
public key without SSH user authentication.
--test additionally attempts real public-key-only SFTP "pwd" and "ls" in
the uploader's /incoming chroot, without any remote file write or upload.

The relay's private key is read only by OpenSSH and never printed/exported.
The SSH host public key is cross-checked against a previously attested pin
BEFORE its ephemeral trusted known_hosts file is passed to OpenSSH.
No cloud API writes, sshd changes, external key enrollment, disk transfer,
or production-release credit from this script.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import urllib.request

PROJECT = "kmj-techno"
ZONE = "us-central1-a"
RELAY_VM = "instance-20260912-094732"
RELAY_IP = "10.128.0.2"
# Compatibility name: legacy ELITE_IP refers to the reviewed DNS-only SSH hostname, never a fixed address.\nELITE_IP = "elite-ssh.kmjtechno.com"
ELITE_ED25519_HOST_PIN = "SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI"
UPLOADER_KEY_PIN = "SHA256:89MZ0NG9pvn1A1CaGJnGyJAAlcGtk0AAXVOBeyN5X80"
UPLOADER = "kmjcloudosbackup"
KEYNAME = "kmj-cloudos-n2-sftp-ed25519"
PUB_COMMENT = "kmj-cloudos-n2-relay-sftp"
SSH_KEYSCAN = "/usr/bin/ssh-keyscan"
SFTP = "/usr/bin/sftp"
B64 = re.compile(r"[A-Za-z0-9+/]+={0,2}\Z")
D = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
F = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
MAX_STDOUT = 8192


class Blocked(RuntimeError):
    pass


def metadata(resource):
    if resource not in (
        "project/project-id", "instance/name", "instance/zone",
        "instance/network-interfaces/0/ip",
    ):
        raise Blocked("METADATA_PATH_NOT_ALLOWLISTED")
    req = urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/" + resource,
        headers={"Metadata-Flavor": "Google"},
    )
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with client.open(req, timeout=5) as response:
            if response.headers.get("Metadata-Flavor") != "Google":
                raise Blocked("GCE_METADATA_RESPONSE_NOT_VERIFIED")
            data = response.read(257)
    except (OSError, TimeoutError):
        raise Blocked("GCE_METADATA_UNAVAILABLE") from None
    if not 1 <= len(data) <= 256:
        raise Blocked("GCE_METADATA_LENGTH_INVALID")
    return data.decode("ascii", "strict").strip()


def exact_relay():
    if os.geteuid() == 0:
        raise Blocked("NONROOT_RELAY_OPERATOR_REQUIRED")
    if (metadata("project/project-id") != PROJECT
            or metadata("instance/name") != RELAY_VM
            or not metadata("instance/zone").endswith("/" + ZONE)
            or metadata("instance/network-interfaces/0/ip") != RELAY_IP):
        raise Blocked("EXACT_RELAY_IDENTITY_MISMATCH")
    print("RELAY_GCE_IDENTITY=EXACT_VERIFIED", flush=True)
    return pwd.getpwuid(os.geteuid()).pw_dir


def read_public(path, uid):
    fd = os.open(path, F)
    try:
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != uid
                or st.st_nlink != 1 or st.st_mode & 0o022
                or not 60 <= st.st_size <= 1024):
            raise Blocked("RELAY_PUBLIC_KEY_FILE_UNTRUSTED")
        content = os.read(fd, 1025)
        if len(content) != st.st_size:
            raise Blocked("RELAY_PUBLIC_KEY_FILE_CHANGED")
        return content.decode("ascii", "strict").strip()
    finally:
        os.close(fd)


def parse_ed25519_public(line, allowed_host=None):
    fields = line.strip().split()
    if allowed_host is None:
        if (len(fields) != 3 or fields[0] != "ssh-ed25519"
                or fields[2] != PUB_COMMENT):
            raise Blocked("UPLOADER_PUBLIC_KEY_IDENTITY_INVALID")
        enc = fields[1]
    else:
        if (len(fields) != 3 or fields[0] != allowed_host
                or fields[1] != "ssh-ed25519"):
            raise Blocked("ELITE_HOST_PUBLIC_RECORD_MISMATCH")
        enc = fields[2]
    if len(enc) > 512 or not B64.fullmatch(enc):
        raise Blocked("ED25519_BASE64_FIELD_INVALID")
    try:
        blob = base64.b64decode(enc, validate=True)
    except (binascii.Error, ValueError):
        raise Blocked("ED25519_PUBLIC_ENCODING_INVALID") from None
    if (len(blob) != 51 or blob[:15] != b"\x00\x00\x00\x0bssh-ed25519"
            or blob[15:19] != b"\x00\x00\x00\x20"):
        raise Blocked("ED25519_PUBLIC_BLOB_INVALID")
    fingerprint = "SHA256:" + base64.b64encode(
        hashlib.sha256(blob).digest()
    ).decode("ascii").rstrip("=")
    return fingerprint


def read_local_identity():
    home = Path(exact_relay())
    user_id = os.geteuid()
    home_stat = home.lstat()
    if (not stat.S_ISDIR(home_stat.st_mode)
            or home_stat.st_uid != user_id
            or home_stat.st_mode & 0o022):
        raise Blocked("RELAY_OPERATOR_HOME_UNTRUSTED")
    ssh_dir = home / ".ssh"
    meta = ssh_dir.lstat()
    if (not stat.S_ISDIR(meta.st_mode) or meta.st_uid != user_id
            or stat.S_IMODE(meta.st_mode) != 0o700):
        raise Blocked("RELAY_SSH_DIR_OWNER_OR_MODE_INVALID")
    private = ssh_dir / KEYNAME
    fd = os.open(str(private), F)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != user_id
                or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600
                or not 40 <= info.st_size <= 8192):
            raise Blocked("RELAY_PRIVATE_IDENTITY_UNTRUSTED")
    finally:
        os.close(fd)
    pub = read_public(str(private) + ".pub", user_id)
    if parse_ed25519_public(pub) != UPLOADER_KEY_PIN:
        raise Blocked("RELAY_UPLOADER_PUBLIC_FINGERPRINT_CHANGED")
    print("RELAY_UPLOADER_LOCAL_ED25519_PIN=PASS", flush=True)
    print("RELAY_SFTP_PRIVATE_KEY=PRIVATE_LOCAL_ONLY", flush=True)
    return private


def run(argv, *, stdin=None, timeout=15):
    try:
        result = subprocess.run(
            argv,
            input=stdin,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("SSH_COMMAND_UNAVAILABLE_OR_TIMEOUT") from None
    if len(result.stdout) > MAX_STDOUT or len(result.stderr) > MAX_STDOUT:
        raise Blocked("SSH_COMMAND_OUTPUT_TOO_LARGE")
    return result


def pin_remote_host():
    result = run(
        [SSH_KEYSCAN, "-4", "-T", "5", "-p", "22", "-t", "ed25519", ELITE_IP],
        timeout=13,
    )
    if result.returncode != 0:
        raise Blocked("ELITE_HOST_PUBLIC_SCAN_FAILED")
    lines = [line.strip() for line in result.stdout.decode("ascii", "strict").splitlines()
             if line.strip() and not line.lstrip().startswith("#")]
    if len(lines) != 1:
        raise Blocked("ELITE_ED25519_HOST_KEY_RECORD_COUNT_INVALID")
    candidate = lines[0]
    if parse_ed25519_public(candidate, allowed_host=ELITE_IP) != ELITE_ED25519_HOST_PIN:
        raise Blocked("ELITE_ED25519_HOST_KEY_PIN_MISMATCH")
    print("RELAY_TO_ELITE_ED25519_HOST_PIN=EXACT_MATCH_VERIFIED", flush=True)
    return (candidate + "\n").encode("ascii")


def actual_sftp(private, pinned_record):
    # Temporary known-host trust file contains the independently pinned
    # ELITE public host key only, never a private key or user credential.
    with tempfile.NamedTemporaryFile(
        mode="w+b", prefix="kmj-cloudos-sftp-hostpin-",
        suffix=".known_hosts", dir="/tmp", delete=True,
    ) as hosts:
        hosts.write(pinned_record)
        hosts.flush()
        os.fsync(hosts.fileno())
        cmd = [
            SFTP,
            "-b", "-",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            "-o", "ConnectionAttempts=1",
            "-o", "StrictHostKeyChecking=yes",
            "-o", "UserKnownHostsFile=" + hosts.name,
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "HostKeyAlgorithms=ssh-ed25519",
            "-o", "PubkeyAcceptedAlgorithms=ssh-ed25519",
            "-o", "PasswordAuthentication=no",
            "-o", "KbdInteractiveAuthentication=no",
            "-o", "IdentitiesOnly=yes",
            "-o", "IdentityAgent=none",
            "-i", str(private),
            "-P", "22",
            UPLOADER + "@" + ELITE_IP,
        ]
        # pwd + ls are read-only; no put, mkdir, rm, rmdir, rename, copy.
        result = run(cmd, stdin=b"pwd\nls /incoming\n", timeout=28)
        if result.returncode:
            raise Blocked("RELAY_TO_ELITE_SFTP_AUTH_OR_READ_FAILED")
        if b"Remote working directory:" not in result.stdout:
            raise Blocked("SFTP_PWD_PROOF_ABSENT")
        print("RELAY_TO_ELITE_AUTHENTICATED_SFTP=PASS", flush=True)
        print("RELAY_SFTP_REMOTE_PWD_AND_INCOMING_LIST=PASS_READ_ONLY", flush=True)
        print("RELAY_SFTP_WRITE_AND_CHROOT_NEGATIVE=NOT_TESTED", flush=True)
        print("RELAY_SFTP_SHELL_AND_FORWARD_NEGATIVE=NOT_TESTED", flush=True)
        print("AGE_ENCRYPTED_N2_BACKUP_AND_RESTORE=NOT_VERIFIED", flush=True)
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)


def self_test():
    pub_blob = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + bytes(range(32))
    encoded = base64.b64encode(pub_blob).decode("ascii")
    normal = "ssh-ed25519 " + encoded + " " + PUB_COMMENT
    host = ELITE_IP + " ssh-ed25519 " + encoded
    expected = "SHA256:" + base64.b64encode(
        hashlib.sha256(pub_blob).digest()
    ).decode().rstrip("=")
    assert parse_ed25519_public(normal) == expected
    assert parse_ed25519_public(host, allowed_host=ELITE_IP) == expected
    for bad in ("ssh-rsa " + encoded + " " + PUB_COMMENT,
                "ssh-ed25519 *** " + PUB_COMMENT,
                host.replace(ELITE_IP, "8.8.8.8"),
                host.replace(encoded, "!!!")):
        try:
            parse_ed25519_public(
                bad, allowed_host=ELITE_IP if bad.startswith(ELITE_IP)
                or bad.startswith("8.8.8.8") else None
            )
        except Blocked:
            continue
        else:
            raise AssertionError("Malformed or mismatched public key accepted")
    assert ELITE_ED25519_HOST_PIN == (
        "SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI"
    )
    assert UPLOADER_KEY_PIN == (
        "SHA256:89MZ0NG9pvn1A1CaGJnGyJAAlcGtk0AAXVOBeyN5X80"
    )
    print("RELAY_ELITE_PINNED_SFTP_SMOKE_OFFLINE_TESTS=PASS", flush=True)


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:] not in (["--inspect"], ["--test"]):
        print("USAGE: script.py --self-test | --inspect | --test")
        return 64
    try:
        private = read_local_identity()
        record = pin_remote_host()
        if sys.argv[1:] == ["--inspect"]:
            print("RELAY_ELITE_SFTP_HOST_TRUST_PREFLIGHT=PASS", flush=True)
            print("RELAY_TO_ELITE_AUTHENTICATED_SFTP=NOT_ATTEMPTED", flush=True)
            print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)
        else:
            actual_sftp(private, record)
        return 0
    except (Blocked, OSError, UnicodeError, ValueError) as error:
        print("RELAY_TO_ELITE_SFTP_SMOKE=BLOCKED", flush=True)
        print("RELAY_SFTP_SMOKE_REASON=" +
              (str(error)[:88] if isinstance(error, Blocked)
               else "RUNTIME_OR_FILESYSTEM_UNAVAILABLE"), flush=True)
        print("RELAY_SFTP_PRIVATE_KEY=NEVER_EXPORTED", flush=True)
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
