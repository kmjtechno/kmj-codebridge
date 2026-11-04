#!/usr/bin/env python3
"""Guarded N2 AGE ciphertext SFTP spool -> private ELITE vault admission.

NO source GCE access, AGE private key, decrypt, guest start, or backup capture.
ONLY copies an existing immutable-looking encrypted spool pair and checks bytes.
--inspect reads only. --promote is root-only and requires explicit opt-in.
A manifest is untrusted: even success NEVER grants restore/release credit.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import pwd
import re
import stat
import sys
import uuid

from kmj_elite_cloudos_n2_cold_archive_integrity_20261104 import (
    Blocked,
    NAME_RE,
    MAX_MANIFEST,
    parse_manifest,
    verify_cipher,
)

HOST = "kmj-elite"
UPLOADER = "kmjcloudosbackup"
CHROOT = "kmj-cloudos-n2-sftp"
SPOOL = "incoming"
VAULT = "kmj-cloudos-n2-offsite"
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
WRITE_FLAGS = os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
CAPTURE = re.compile(r"[0-9a-f]{32}\Z")
MAX_CIPHER = 65 * 1024**3
RESERVE_BYTES = 8 * 1024**3
CHUNK = 1024 * 1024
AGE_HEADER = b"age-encryption.org/v1\n"


def require_dir(parent_fd, name, uid, mode):
    fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    st = os.fstat(fd)
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid != uid
            or stat.S_IMODE(st.st_mode) != mode or st.st_nlink < 2):
        os.close(fd)
        raise Blocked("DIRECTORY_IDENTITY_OR_PERMISSIONS_MISMATCH")
    return fd


def require_file(parent_fd, name, uid, max_bytes):
    fd = os.open(name, FILE_FLAGS, dir_fd=parent_fd)
    st = os.fstat(fd)
    if (not stat.S_ISREG(st.st_mode) or st.st_uid != uid
            or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1
            or not 1 <= st.st_size <= max_bytes):
        os.close(fd)
        raise Blocked("SPOOL_REGULAR_EXCLUSIVE_0600_FILE_REQUIRED")
    return fd, st


def immutable_receipt(st):
    return (
        st.st_dev, st.st_ino, st.st_uid, st.st_gid,
        st.st_mode, st.st_nlink, st.st_size,
        st.st_mtime_ns, st.st_ctime_ns,
    )


def no_change(fd, old):
    if immutable_receipt(os.fstat(fd)) != immutable_receipt(old):
        raise Blocked("SPOOL_SOURCE_MUTATED_DURING_COPY")


def read_manifest(spool_fd, uploader_uid, capture):
    name = "n2-cold-" + capture + ".json"
    fd, before = require_file(spool_fd, name, uploader_uid, MAX_MANIFEST)
    try:
        data = os.read(fd, MAX_MANIFEST + 1)
        if len(data) != before.st_size:
            raise Blocked("SPOOL_MANIFEST_SIZE_CHANGED")
        no_change(fd, before)
    finally:
        os.close(fd)
    manifest = parse_manifest(data, name)
    return data, manifest


def cannot_overwrite(dir_fd, filename):
    try:
        os.stat(filename, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise Blocked("DESTINATION_ALREADY_EXISTS_NO_OVERWRITE")


def stream_copy(src_fd, dst_fd, expected_size, expected_sha):
    if not 128 <= expected_size <= MAX_CIPHER:
        raise Blocked("CIPHERTEXT_LENGTH_BOUNDS_DENIED")
    if not isinstance(expected_sha, str) or SHA256.fullmatch(expected_sha) is None:
        raise Blocked("INVALID_PINNED_CIPHERTEXT_SHA256")
    h = hashlib.sha256()
    total = 0
    header = bytearray()
    while total < expected_size:
        chunk = os.read(src_fd, min(CHUNK, expected_size - total))
        if not chunk:
            raise Blocked("SOURCE_CIPHERTEXT_TRUNCATED")
        if len(header) < len(AGE_HEADER):
            header += chunk[:len(AGE_HEADER) - len(header)]
            if len(header) == len(AGE_HEADER) and bytes(header) != AGE_HEADER:
                raise Blocked("SOURCE_AGE_HEADER_INVALID")
        total += len(chunk)
        h.update(chunk)
        if dst_fd is not None:
            view = memoryview(chunk)
            while len(view):
                written = os.write(dst_fd, view)
                if written <= 0:
                    raise Blocked("VAULT_WRITE_FAILED")
                view = view[written:]
    if os.read(src_fd, 1):
        raise Blocked("SOURCE_CIPHERTEXT_GREW_DURING_READ")
    if total != expected_size or bytes(header) != AGE_HEADER:
        raise Blocked("SOURCE_AGE_HEADER_OR_SIZE_INVALID")
    if h.hexdigest() != expected_sha:
        raise Blocked("SPOOL_CIPHERTEXT_INDEPENDENT_PIN_MISMATCH")


def check_space(vault_fd, cipher_size):
    fs = os.fstatvfs(vault_fd)
    free = fs.f_bavail * fs.f_frsize
    if free < cipher_size + RESERVE_BYTES:
        raise Blocked("VAULT_FREE_SPACE_HEADROOM_INSUFFICIENT")


def exclusive_temp(vault_fd, name):
    fd = os.open(name, WRITE_FLAGS, 0o600, dir_fd=vault_fd)
    os.fchmod(fd, 0o600)
    return fd


def remove_if_our_inode(dir_fd, name, inode):
    try:
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if st.st_ino == inode and stat.S_ISREG(st.st_mode):
        os.unlink(name, dir_fd=dir_fd)


def admission(spool_fd, vault_fd, uid, capture, pinned, *, promote):
    if not isinstance(capture, str) or CAPTURE.fullmatch(capture) is None:
        raise Blocked("CAPTURE_ID_NOT_EXACT_32_HEX")
    if not isinstance(pinned, str) or SHA256.fullmatch(pinned) is None:
        raise Blocked("INDEPENDENT_SOURCE_CIPHERTEXT_SHA256_PIN_REQUIRED")
    raw_manifest, manifest = read_manifest(spool_fd, uid, capture)
    if manifest["ciphertext_sha256"] != pinned:
        raise Blocked("SOURCE_PIN_MISMATCHES_UNTRUSTED_MANIFEST")
    cname = "n2-cold-" + capture + ".age"
    mname = "n2-cold-" + capture + ".json"
    if NAME_RE.fullmatch(mname) is None:
        raise Blocked("COLD_MANIFEST_FILENAME_NOT_ACCEPTED")
    cannot_overwrite(vault_fd, cname)
    cannot_overwrite(vault_fd, mname)
    source_fd, original = require_file(spool_fd, cname, uid, MAX_CIPHER)
    temp_c = temp_m = None
    cipher_staged_inode = manifest_staged_inode = None
    linked_cipher = linked_manifest = False
    try:
        if original.st_size != manifest["ciphertext_bytes"]:
            raise Blocked("SPOOL_CIPHERTEXT_SIZE_MANIFEST_MISMATCH")
        os.lseek(source_fd, 0, os.SEEK_SET)
        if not promote:
            stream_copy(source_fd, None, original.st_size, pinned)
            no_change(source_fd, original)
            return manifest

        check_space(vault_fd, original.st_size)
        nonce = uuid.uuid4().hex
        temp_c = ".kmj-cold-" + capture + "-" + nonce + ".age.tmp"
        temp_m = ".kmj-cold-" + capture + "-" + nonce + ".json.tmp"
        cfd = exclusive_temp(vault_fd, temp_c)
        try:
            cipher_staged_inode = os.fstat(cfd).st_ino
            stream_copy(source_fd, cfd, original.st_size, pinned)
            os.fsync(cfd)
        finally:
            os.close(cfd)
        no_change(source_fd, original)

        # Re-hash the root-owned vault temp ciphertext, not just the spool stream.
        read_fd, trusted = require_file(vault_fd, temp_c, os.geteuid(), MAX_CIPHER)
        try:
            if trusted.st_size != original.st_size:
                raise Blocked("VAULT_STAGE_SIZE_DIFFERENT")
            verify_cipher(read_fd, trusted.st_size, pinned)
            no_change(read_fd, trusted)
        finally:
            os.close(read_fd)

        mfd = exclusive_temp(vault_fd, temp_m)
        try:
            manifest_staged_inode = os.fstat(mfd).st_ino
            view = memoryview(raw_manifest)
            while len(view):
                written = os.write(mfd, view)
                if written <= 0:
                    raise Blocked("MANIFEST_WRITE_FAILED")
                view = view[written:]
            os.fsync(mfd)
        finally:
            os.close(mfd)

        # Hard-link publication is exclusive: never replace a preexisting path.
        # Manifest becomes visible LAST. Root vault and staging share a filesystem.
        os.link(temp_c, cname, src_dir_fd=vault_fd, dst_dir_fd=vault_fd,
                follow_symlinks=False)
        linked_cipher = True
        os.link(temp_m, mname, src_dir_fd=vault_fd, dst_dir_fd=vault_fd,
                follow_symlinks=False)
        linked_manifest = True
        os.fsync(vault_fd)
        return manifest
    except Exception:
        # On interrupted publish, remove only paths proven created by this call.
        if linked_manifest and manifest_staged_inode is not None:
            remove_if_our_inode(vault_fd, mname, manifest_staged_inode)
        if linked_cipher and cipher_staged_inode is not None:
            remove_if_our_inode(vault_fd, cname, cipher_staged_inode)
        raise
    finally:
        os.close(source_fd)
        if temp_c is not None and cipher_staged_inode is not None:
            remove_if_our_inode(vault_fd, temp_c, cipher_staged_inode)
        if temp_m is not None and manifest_staged_inode is not None:
            remove_if_our_inode(vault_fd, temp_m, manifest_staged_inode)


def host_admission(capture, pinned, *, promote):
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0].lower() != HOST:
        raise Blocked("EXACT_ELITE_ROOT_REQUIRED")
    uploader = pwd.getpwnam(UPLOADER)
    if uploader.pw_uid < 1000 or uploader.pw_gid < 1000 or uploader.pw_shell not in (
            "/usr/sbin/nologin", "/bin/false"):
        raise Blocked("SFTP_UPLOADER_IDENTITY_UNTRUSTED")

    root = os.open("/", DIR_FLAGS)
    try:
        parent = require_dir(root, "srv", 0, 0o755)
        try:
            chroot = require_dir(parent, CHROOT, 0, 0o755)
            try:
                spool = require_dir(chroot, SPOOL, uploader.pw_uid, 0o700)
                try:
                    vault = require_dir(parent, VAULT, 0, 0o700)
                    try:
                        # Do not move across surprise mounted filesystems.
                        if (os.fstat(root).st_dev != os.fstat(parent).st_dev
                                or os.fstat(chroot).st_dev != os.fstat(parent).st_dev
                                or os.fstat(spool).st_dev != os.fstat(parent).st_dev
                                or os.fstat(vault).st_dev != os.fstat(parent).st_dev):
                            raise Blocked("UNEXPECTED_SPOOL_OR_VAULT_FILESYSTEM")
                        return admission(spool, vault, uploader.pw_uid, capture, pinned,
                                         promote=promote)
                    finally:
                        os.close(vault)
                finally:
                    os.close(spool)
            finally:
                os.close(chroot)
        finally:
            os.close(parent)
    finally:
        os.close(root)


def self_test():
    fake = b"age-encryption.org/v1\n" + b"nonsensitive-offline-data" * 10
    digest = hashlib.sha256(fake).hexdigest()
    from tempfile import TemporaryFile
    with TemporaryFile() as f:
        f.write(fake)
        f.seek(0)
        stream_copy(f.fileno(), None, len(fake), digest)
        f.seek(0)
        try:
            stream_copy(f.fileno(), None, len(fake), "f" * 64)
        except Blocked:
            pass
        else:
            raise AssertionError("WRONG_CIPHER_DIGEST_ACCEPTED")
    assert CAPTURE.fullmatch("a" * 32)
    assert not CAPTURE.fullmatch("../../")
    print("CLOUDOS_N2_SFTP_VAULT_ADMISSION_OFFLINE_TESTS=PASS")
    print("N2_DISPOSABLE_BOOT_RESTORE=NOT_VERIFIED")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--self-test", action="store_true")
    group.add_argument("--inspect", metavar="32-HEX-CAPTURE-ID")
    group.add_argument("--promote", metavar="32-HEX-CAPTURE-ID")
    parser.add_argument("--source-cipher-sha256", metavar="64-HEX-DIGEST")
    parser.add_argument("--approve-root-copy", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if args.promote and not args.approve_root_copy:
        raise Blocked("ROOT_COPY_APPROVAL_NOT_SUPPLIED")
    if not args.promote and args.approve_root_copy:
        raise Blocked("APPROVAL_WITHOUT_PROMOTION_DENIED")
    manifest = host_admission(
        args.promote or args.inspect,
        args.source_cipher_sha256,
        promote=bool(args.promote),
    )
    print("SPOOL_CIPHERTEXT_MANIFEST_AND_INDEPENDENT_PIN_SHA256=PASS")
    print("SPOOL_CIPHERTEXT_BYTES=" + str(manifest["ciphertext_bytes"]))
    if args.promote:
        print("N2_COLD_CIPHERTEXT_ROOT_VAULT_PROMOTION=PASS_COPY_ONLY")
    else:
        print("N2_COLD_CIPHERTEXT_ROOT_VAULT_PROMOTION=NOT_ATTEMPTED")
    print("N2_SFTP_UNTRUSTED_SPOOL=LEFT_UNMODIFIED")
    print("N2_SOURCE_DISK_COMPLETENESS=NOT_INDEPENDENTLY_ATTESTED")
    print("N2_OWNER_AGE_PRIVATE_KEY_ON_ELITE=NONE")
    print("N2_INDEPENDENT_BOOTED_RESTORE=NOT_VERIFIED")
    print("GCE_OR_VM_MUTATIONS=NONE")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Blocked, OSError, KeyError, ValueError) as exc:
        print("N2_COLD_SPOOL_PROMOTION=BLOCKED")
        print("N2_COLD_SPOOL_BLOCKER=" + (
            str(exc) if isinstance(exc, Blocked) else "FILESYSTEM_OR_ACCOUNT_UNAVAILABLE"))
        print("N2_SOURCE_AND_RESTORE=NOT_VERIFIED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        raise SystemExit(2)
