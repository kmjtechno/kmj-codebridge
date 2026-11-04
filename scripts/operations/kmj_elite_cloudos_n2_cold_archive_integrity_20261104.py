#!/usr/bin/env python3
"""Read-only ELITE AGE ciphertext + untrusted cold-N2 manifest integrity audit.

Never creates backups, copies private AGE keys, changes N2, restarts a VM,
attests source completeness, or qualifies independently bootable restore.
"""
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone

HOST = "kmj-elite"
VAULT = "kmj-cloudos-n2-offsite"
SOURCE_PROJECT = "kmj-techno"
SOURCE_ZONE = "us-central1-a"
SOURCE_INSTANCE = "kmj-cloudos-kvm-test"
RECIPIENT_SHA = "9cfac857eaf977abcb38d26d631c8f24375996c3e0e4c8725f0a410215b1ce70"
SCHEMA = "kmj.cloudos.n2.cold-cipher-manifest.v1"
NAME_RE = re.compile(r"n2-cold-([0-9a-f]{32})\.json\Z")
HEX_RE = re.compile(r"[0-9a-f]{64}\Z")
FIELDS = frozenset({
    "schema", "capture_id", "project", "zone", "instance", "source_disk_bytes",
    "captured_at_utc", "capture_method", "source_state_reported",
    "age_recipient_sha256", "ciphertext_bytes", "ciphertext_sha256"
})
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
MAX_MANIFEST = 4096
AGE_HEADER = b"age-encryption.org/v1\n"


class Blocked(RuntimeError):
    pass


def trusted_dir(parent, child, mode=None):
    fd = os.open(child, DIR, dir_fd=parent)
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
            or info.st_mode & 0o022
            or (mode is not None and stat.S_IMODE(info.st_mode) != mode)):
        os.close(fd)
        raise Blocked("ROOT_DIRECTORY_UNTRUSTED")
    return fd


def trusted_file(parent, name, max_size=None):
    fd = os.open(name, FILE, dir_fd=parent)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
        os.close(fd)
        raise Blocked("ROOT_0600_REGULAR_FILE_REQUIRED")
    if max_size is not None and not 1 <= info.st_size <= max_size:
        os.close(fd)
        raise Blocked("MANIFEST_SIZE_UNTRUSTED")
    return fd, info


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Blocked("DUPLICATE_MANIFEST_FIELD")
        result[key] = value
    return result


def parse_manifest(data, name, now=None):
    if not 40 <= len(data) <= MAX_MANIFEST or b"\0" in data:
        raise Blocked("MANIFEST_BYTES_UNTRUSTED")
    try:
        payload = json.loads(data.decode("utf-8", "strict"), object_pairs_hook=no_duplicates)
    except (UnicodeError, ValueError, TypeError) as exc:
        raise Blocked("MANIFEST_JSON_INVALID") from exc
    if not isinstance(payload, dict) or set(payload) != FIELDS:
        raise Blocked("MANIFEST_FIELDS_UNEXPECTED")
    match = NAME_RE.fullmatch(name)
    if match is None or payload["capture_id"] != match.group(1):
        raise Blocked("CAPTURE_ID_FILENAME_MISMATCH")
    policy = {
        "schema": SCHEMA, "project": SOURCE_PROJECT, "zone": SOURCE_ZONE,
        "instance": SOURCE_INSTANCE, "capture_method": "cold-block-read",
        "source_state_reported": "TERMINATED",
        "age_recipient_sha256": RECIPIENT_SHA,
    }
    for key, value in policy.items():
        if type(payload[key]) is not str or payload[key] != value:
            raise Blocked("N2_SOURCE_OR_AGE_POLICY_MISMATCH")
    for key in ("source_disk_bytes", "ciphertext_bytes"):
        if type(payload[key]) is not int:
            raise Blocked("MANIFEST_SIZE_NOT_INTEGER")
    if not 25 * 1024**3 <= payload["source_disk_bytes"] <= 40 * 1024**3:
        raise Blocked("N2_SOURCE_DISK_SIZE_OUT_OF_RANGE")
    if not 128 <= payload["ciphertext_bytes"] <= 65 * 1024**3:
        raise Blocked("CIPHERTEXT_SIZE_OUT_OF_RANGE")
    if (type(payload["ciphertext_sha256"]) is not str
            or HEX_RE.fullmatch(payload["ciphertext_sha256"]) is None):
        raise Blocked("CIPHERTEXT_DIGEST_INVALID")
    ts = payload["captured_at_utc"]
    if type(ts) is not str or re.fullmatch(r"20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ", ts) is None:
        raise Blocked("CAPTURE_TIMESTAMP_FORMAT_INVALID")
    try:
        stamp = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise Blocked("CAPTURE_TIMESTAMP_INVALID") from exc
    if stamp.year < 2026 or stamp > (now or datetime.now(timezone.utc)):
        raise Blocked("CAPTURE_TIMESTAMP_OUT_OF_RANGE")
    return payload


def verify_cipher(fd, expected_size, expected_sha):
    if not 128 <= expected_size <= 65 * 1024**3:
        raise Blocked("CIPHERTEXT_SIZE_UNSAFE")
    if os.read(fd, len(AGE_HEADER)) != AGE_HEADER:
        raise Blocked("CIPHERTEXT_MISSING_AGE_HEADER")
    os.lseek(fd, 0, os.SEEK_SET)
    sha = hashlib.sha256()
    count = 0
    while count < expected_size:
        chunk = os.read(fd, min(1024 * 1024, expected_size - count))
        if not chunk:
            raise Blocked("CIPHERTEXT_TRUNCATED")
        count += len(chunk)
        sha.update(chunk)
    if count != expected_size or os.read(fd, 1):
        raise Blocked("CIPHERTEXT_CHANGED_DURING_READ")
    if sha.hexdigest() != expected_sha:
        raise Blocked("CIPHERTEXT_SHA256_MISMATCH")


def not_qualified():
    print("N2_SOURCE_TERMINATION=NOT_INDEPENDENTLY_ATTESTED")
    print("N2_SOURCE_DISK_COMPLETENESS=NOT_INDEPENDENTLY_ATTESTED")
    print("N2_INDEPENDENT_DISPOSABLE_BOOT_RESTORE=NOT_VERIFIED")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")


def inspect():
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("EXACT_ROOT_ELITE_REQUIRED")
    root = os.open("/", DIR)
    try:
        srv = trusted_dir(root, "srv")
        try:
            vault = trusted_dir(srv, VAULT, mode=0o700)
            try:
                if os.fstat(vault).st_dev != os.fstat(root).st_dev:
                    raise Blocked("UNEXPECTED_BACKUP_VAULT_FILESYSTEM")
                choices = [name for name in os.listdir(vault) if NAME_RE.fullmatch(name)]
                if not choices:
                    print("N2_COLD_CIPHERTEXT_ARCHIVE=NOT_PRESENT")
                    print("N2_COLD_CIPHERTEXT_INTEGRITY=NOT_TESTED")
                    not_qualified()
                    return 0
                if len(choices) != 1:
                    raise Blocked("EXACTLY_ONE_COLD_ARCHIVE_MANIFEST_REQUIRED")
                name = choices[0]
                mfd, mstat = trusted_file(vault, name, MAX_MANIFEST)
                try:
                    raw = os.read(mfd, MAX_MANIFEST + 1)
                    if len(raw) != mstat.st_size or os.fstat(mfd).st_size != mstat.st_size:
                        raise Blocked("MANIFEST_CHANGED_DURING_READ")
                    payload = parse_manifest(raw, name)
                finally:
                    os.close(mfd)
                ciphertext = name[:-5] + ".age"
                cfd, before = trusted_file(vault, ciphertext)
                try:
                    if before.st_size != payload["ciphertext_bytes"]:
                        raise Blocked("CIPHER_FILE_MANIFEST_SIZE_MISMATCH")
                    verify_cipher(cfd, before.st_size, payload["ciphertext_sha256"])
                    after = os.fstat(cfd)
                    original = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                    current = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                    if current != original:
                        raise Blocked("CIPHERTEXT_MUTATED_DURING_SHA")
                finally:
                    os.close(cfd)
                print("N2_COLD_CIPHERTEXT_ARCHIVE=PRESENT_ROOT_0600")
                print("N2_COLD_CIPHERTEXT_INTEGRITY=PASS_LOCAL_UNTRUSTED_MANIFEST_SHA256")
                print("N2_COLD_CIPHERTEXT_BYTES=" + str(payload["ciphertext_bytes"]))
                print("N2_COLD_PUBLIC_RECIPIENT_FINGERPRINT=MATCH")
            finally:
                os.close(vault)
        finally:
            os.close(srv)
    finally:
        os.close(root)
    not_qualified()
    return 0


def main():
    if sys.argv[1:] != ["--inspect"]:
        print("USAGE: script.py --inspect")
        return 64
    try:
        return inspect()
    except (Blocked, OSError) as exc:
        print("N2_COLD_CIPHERTEXT_INTEGRITY=BLOCKED")
        print("N2_COLD_CIPHERTEXT_BLOCKER=" +
              (str(exc) if isinstance(exc, Blocked) else "FILESYSTEM_UNAVAILABLE"))
        not_qualified()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
