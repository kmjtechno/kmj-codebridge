#!/usr/bin/env python3
"""Authenticated bounded SFTP canary only, never a backup or VM operation.

On the existing exact GCE relay as nonroot:
* enforce the immutable PR820 SFTP smoke SHA-256 before importing it
* verify exact relay metadata, local private key and pinned ELITE SSH host key
* perform read-only positive control before uploading
* create a random remote /incoming/ directory with SFTP mkdir (no overwrite)
* upload one small random canary, read it back, compare SHA256
* remove exactly that file, remove its directory, then verify it is absent

Unattended SSH publickey-only with no known_hosts trust downgrade. Does not
print SSH private keys, passphrases, canary contents or remote listings.
If cleanup fails, print ONLY the random remote canary path for manual review.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import secrets
import stat
import sys
import tempfile

SOURCE = Path(__file__).resolve().parent / "kmj_cloudos_relay_elite_sftp_auth_smoke_20261103.py"
SOURCE_SHA256 = "b3224318810bc7fffe28571f7545cbf3de3453ac9220140d750bdc4ce0ec4c1c"
MAX_BYTES = 96
NAME_PREFIX = ".kmj-cloudos-relay-canary-"


class Blocked(RuntimeError):
    pass


def pinned_smoke():
    meta = SOURCE.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_mode & 0o022:
        raise Blocked("PINNED_SMOKE_SOURCE_NOT_TRUSTED")
    if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise Blocked("PINNED_SMOKE_SHA256_MISMATCH")
    spec = importlib.util.spec_from_file_location("kmj_canary_pinned_smoke", SOURCE)
    smoke = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = smoke
    spec.loader.exec_module(smoke)
    return smoke


def sftp_args(smoke, private, known_hosts):
    return [
        smoke.SFTP,
        "-F", "/dev/null",
        "-b", "-",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ConnectionAttempts=1",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=" + str(known_hosts),
        "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "HostKeyAlgorithms=ssh-ed25519",
        "-o", "PubkeyAcceptedAlgorithms=ssh-ed25519",
        "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no",
        "-o", "PreferredAuthentications=publickey",
        "-o", "IdentitiesOnly=yes",
        "-o", "IdentityAgent=none",
        "-i", str(private),
        "-P", "22",
        smoke.UPLOADER + "@" + smoke.ELITE_IP,
    ]


def sftp(smoke, args, batch, timeout=28):
    # The batch is constructed exclusively from local random hex and
    # strictly bounded paths. Never render raw remote output.
    result = smoke.run(args, stdin=batch.encode("ascii"), timeout=timeout)
    return result


def canary(smoke, private, trusted_host):
    with tempfile.TemporaryDirectory(prefix="kmj-cloudos-canary-", dir="/tmp") as tmp:
        area = Path(tmp)
        os.chmod(area, 0o700)
        src, dst = area / "source.bin", area / "readback.bin"
        contents = b"KMJ-CLOUDOS-SFTP-RECEIVER-CANARY-V1:" + secrets.token_bytes(32)
        if len(contents) > MAX_BYTES:
            raise Blocked("CANARY_BYTES_EXCEEDED")
        fd = os.open(src, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, contents)
            os.fsync(fd)
        finally:
            os.close(fd)
        hostpin = area / "known_hosts"
        fd = os.open(hostpin, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, trusted_host)
            os.fsync(fd)
        finally:
            os.close(fd)

        args = sftp_args(smoke, private, hostpin)
        unique = secrets.token_hex(16)
        remote_dir = "/incoming/" + NAME_PREFIX + unique
        remote_file = remote_dir + "/canary.bin"
        created = False
        transfer_success = False
        cleanup_verified = False
        failure = None
        try:
            created = True  # A timed-out mkdir might still have created the directory.
            if sftp(smoke, args, "mkdir " + remote_dir + "\n").returncode:
                raise Blocked("CANARY_REMOTE_EXCLUSIVE_DIRECTORY_CREATE_FAILED")
            print("RELAY_SFTP_REMOTE_CANARY_DIR=CREATED_EXCLUSIVE", flush=True)
            if sftp(smoke, args, "put " + str(src) + " " + remote_file + "\n").returncode:
                raise Blocked("CANARY_REMOTE_UPLOAD_FAILED")
            if sftp(smoke, args, "get " + remote_file + " " + str(dst) + "\n").returncode:
                raise Blocked("CANARY_REMOTE_READBACK_FAILED")
            readback = dst.read_bytes()
            if readback != contents or hashlib.sha256(readback).digest() != hashlib.sha256(contents).digest():
                raise Blocked("CANARY_CONTENT_INTEGRITY_MISMATCH")
            transfer_success = True
            print("RELAY_SFTP_CANARY_UPLOAD_READBACK_SHA256=PASS", flush=True)
        except (Blocked, OSError, UnicodeError) as exc:
            failure = exc
        finally:
            if created:
                # Always attempt exact-path cleanup, never glob or unrelated
                # deletion, even after an authentication or upload error.
                try:
                    rm = sftp(smoke, args, "rm " + remote_file + "\n")
                    rmdir = sftp(smoke, args, "rmdir " + remote_dir + "\n")
                    absent = sftp(smoke, args, "ls " + remote_dir + "\n")
                    cleanup_verified = (rmdir.returncode == 0
                                        and absent.returncode != 0
                                        and (rm.returncode == 0
                                             or not transfer_success))
                except (Blocked, OSError, UnicodeError, ValueError):
                    cleanup_verified = False
        if not cleanup_verified:
            print("RELAY_SFTP_CANARY_CLEANUP=NOT_VERIFIED", flush=True)
            print("RELAY_SFTP_CANARY_REMOTE_PATH=" + remote_dir, flush=True)
            raise Blocked("REMOTE_CANARY_CLEANUP_REQUIRES_REVIEW")
        print("RELAY_SFTP_CANARY_CLEANUP=PASS_REMOTE_ABSENT", flush=True)
        if failure is not None:
            raise Blocked(str(failure)) from None
        if not transfer_success:
            raise Blocked("CANARY_TRANSFER_NOT_PROVEN")
        print("RELAY_SFTP_CANARY_WRITE_READ_DELETE=PASS", flush=True)
        print("RELAY_OWNER_AGE_RECOVERY_AND_N2_RESTORE=NOT_VERIFIED", flush=True)
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)


def self_test():
    assert NAME_PREFIX.startswith(".kmj-cloudos-")
    assert SOURCE_SHA256 == "b3224318810bc7fffe28571f7545cbf3de3453ac9220140d750bdc4ce0ec4c1c"
    assert MAX_BYTES <= 96
    assert len(secrets.token_hex(16)) == 32
    assert "/incoming/" + NAME_PREFIX + "a" * 32 != "/incoming/"
    print("RELAY_SFTP_BOUNDED_CANARY_OFFLINE_TESTS=PASS", flush=True)


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:] != ["--canary"]:
        print("USAGE: script --self-test | --canary")
        return 64
    try:
        smoke = pinned_smoke()
        private = smoke.read_local_identity()
        host = smoke.pin_remote_host()
        smoke.actual_sftp(private, host)
        print("RELAY_SFTP_IDENTITY_HOSTPIN_AND_POSITIVE_AUTH=PASS", flush=True)
        canary(smoke, private, host)
        return 0
    except (Blocked, OSError, UnicodeError, ValueError) as exc:
        print("RELAY_SFTP_CANARY_WRITE_READ_DELETE=BLOCKED", flush=True)
        print("RELAY_SFTP_CANARY_REASON=" +
              (str(exc)[:90] if isinstance(exc, Blocked)
               else "LOCAL_RUNTIME_OR_FILESYSTEM_UNAVAILABLE"), flush=True)
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
