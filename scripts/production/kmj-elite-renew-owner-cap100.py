#!/usr/bin/env python3
"""Owner-only reviewed Elite policy cap renewal, with no signing or key reads.

Run from a reviewed, root-controlled installation with python3 -I -B.
The owner-approved cap is fixed at 100. Expiry and all other fields remain
unchanged. No service, network, Git operation, or release is performed.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import pwd
import re
import secrets
import socket
import stat
import sys

HOME = "/var/lib/kmj-codebridge-signer"
TARGET_CAP = 100
POLICY = "auto-sign-policy.json"
LOCK = "single-flight.lock"
FIELDS = frozenset({
    "approvedAt", "enabled", "expiresAt", "keyFile", "keyId", "maxSequence",
    "ownerConsent", "profile", "publicKeyFile", "repo", "repoPath", "schema",
})


class Blocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Blocked(code)


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_POLICY_FIELD")
        result[key] = value
    return result


def parse_time(value):
    require(isinstance(value, str) and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z", value),
        "POLICY_DATE_INVALID")
    return dt.datetime.fromisoformat(value[:-1] + "+00:00")


def plan(raw, now):
    require(20 <= len(raw) <= 8192, "POLICY_SIZE_INVALID")
    old = json.loads(raw, object_pairs_hook=unique_pairs)
    require(isinstance(old, dict) and set(old) == FIELDS, "POLICY_SCHEMA_INVALID")
    require(
        type(old["schema"]) is int and old["schema"] == 1
        and old["enabled"] is True
        and old["repo"] == "kmjtechno/kmj-codebridge"
        and old["profile"] == "owner-host-auto-sign-stable-only"
        and old["ownerConsent"] == "AUTO_SIGN_REVIEWED_MAIN_ONLY"
        and old["keyId"] == "kmj-release-2026"
        and old["repoPath"] == HOME + "/source/kmj-codebridge"
        and old["keyFile"] == HOME + "/.config/kmj-codebridge/kmj-release-original.pem"
        and old["publicKeyFile"] == HOME + "/.config/kmj-codebridge/kmj-release-original.pub",
        "POLICY_IDENTITY_MISMATCH")
    cap = old["maxSequence"]
    require(type(cap) is int and 30 <= cap <= TARGET_CAP, "POLICY_CAP_OUTSIDE_SCOPE")
    approved = parse_time(old["approvedAt"])
    expires = parse_time(old["expiresAt"])
    require(approved <= now < expires and expires - approved <= dt.timedelta(days=30),
            "POLICY_EXPIRED_OR_INVALID")
    new = dict(old)
    new["maxSequence"] = TARGET_CAP
    return old, new


def open_private_dir(parts, uid):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open("/", flags)
    try:
        for index, component in enumerate(parts):
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            st = os.fstat(fd)
            if index < 2:
                require(st.st_uid == 0 and not st.st_mode & 0o022,
                        "SYSTEM_DIRECTORY_UNTRUSTED")
            else:
                require(st.st_uid == uid and not st.st_mode & 0o077,
                        "SIGNER_DIRECTORY_UNTRUSTED")
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_policy(fd, uid):
    handle = os.open(POLICY, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=fd)
    try:
        before = os.fstat(handle)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == uid
                and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600
                and 20 <= before.st_size <= 8192, "POLICY_FILE_UNTRUSTED")
        raw = os.read(handle, 8193)
        after = os.fstat(handle)
        require(len(raw) == before.st_size and
                (before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_ino, after.st_size, after.st_mtime_ns), "POLICY_READ_RACE")
        return raw
    finally:
        os.close(handle)


def create_file(fd, name, raw):
    handle = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                     | os.O_CLOEXEC, 0o600, dir_fd=fd)
    try:
        with os.fdopen(handle, "wb", closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(handle)
    finally:
        os.close(handle)


def identity(st):
    return st.st_dev, st.st_ino


def remove_own_lock(fd, lock_id):
    st = os.stat(LOCK, dir_fd=fd, follow_symlinks=False)
    require(identity(st) == lock_id, "SIGNER_LOCK_CHANGED")
    os.unlink(LOCK, dir_fd=fd)
    os.fsync(fd)


def run(config, state, uid, args, now):
    try:
        lock = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                       | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=state)
    except FileExistsError:
        raise Blocked("SIGNER_BUSY_OR_STALE_LOCK") from None
    lock_id = identity(os.fstat(lock))
    try:
        try:
            os.write(lock, str(os.getpid()).encode("ascii"))
            os.fsync(lock)
        finally:
            os.close(lock)
        raw = read_policy(config, uid)
        old, new = plan(raw, now)
        digest = hashlib.sha256(raw).hexdigest()
        print("POLICY_SHA256=" + digest)
        print("CURRENT_CAP=" + str(old["maxSequence"]))
        print("PROPOSED_CAP=" + str(TARGET_CAP))
        print("EXPIRY_UNCHANGED=YES")
        if not args.apply:
            print("POLICY_RENEWAL=INSPECT_ONLY")
            return
        require(args.confirm == "OWNER_APPROVES_CAP_100_KEEP_EXPIRY"
                and args.expected_policy_sha256 == digest, "OWNER_APPROVAL_MISMATCH")
        if old == new:
            print("POLICY_RENEWAL=ALREADY_CURRENT")
            return
        backup = POLICY + ".before-cap100-" + digest
        create_file(config, backup, raw)
        os.fsync(config)
        temp = ".policy-cap100-" + secrets.token_hex(16)
        payload = (json.dumps(new, sort_keys=True, indent=2) + "\n").encode("utf8")
        try:
            create_file(config, temp, payload)
            require(read_policy(config, uid) == raw, "POLICY_CHANGED_BEFORE_WRITE")
            # Atomic replacement in the same verified private directory.
            os.replace(temp, POLICY, src_dir_fd=config, dst_dir_fd=config)
            os.fsync(config)
            after = read_policy(config, uid)
            require(after == payload, "POLICY_READBACK_FAILED")
            parsed, _ = plan(after, dt.datetime.now(dt.timezone.utc))
            require(parsed == new, "POLICY_READBACK_FAILED")
        finally:
            try:
                os.unlink(temp, dir_fd=config)
            except FileNotFoundError:
                pass
        print("POLICY_RENEWAL=PASS")
    finally:
        remove_own_lock(state, lock_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-policy-sha256")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    require(os.getuid() == 0 and os.geteuid() == 0
            and socket.gethostname().split(".")[0].lower() == "kmj-elite",
            "ELITE_OWNER_ROOT_REQUIRED")
    if args.apply:
        require(args.confirm == "OWNER_APPROVES_CAP_100_KEEP_EXPIRY"
                and isinstance(args.expected_policy_sha256, str)
                and re.fullmatch(r"[a-f0-9]{64}", args.expected_policy_sha256),
                "OWNER_APPROVAL_REQUIRED")
    else:
        require(args.confirm is None and args.expected_policy_sha256 is None,
                "INSPECT_ARGUMENTS_INVALID")
    signer = pwd.getpwnam("kmjsigner")
    require(signer.pw_uid != 0 and signer.pw_gid != 0 and signer.pw_dir == HOME
            and signer.pw_shell.endswith("/nologin"), "SIGNER_IDENTITY_MISMATCH")
    # The owner invokes the script, but all policy I/O runs without root.
    os.setgroups([])
    os.setgid(signer.pw_gid)
    os.setuid(signer.pw_uid)
    require(os.getuid() == signer.pw_uid and os.geteuid() == signer.pw_uid,
            "SIGNER_IDENTITY_MISMATCH")
    os.umask(0o077)
    config = open_private_dir(["var", "lib", "kmj-codebridge-signer",
                               ".config", "kmj-codebridge"], signer.pw_uid)
    try:
        state = open_private_dir(["var", "lib", "kmj-codebridge-signer",
                                  ".local", "state", "kmj-codebridge", "auto-sign"],
                                 signer.pw_uid)
        try:
            run(config, state, signer.pw_uid, args, dt.datetime.now(dt.timezone.utc))
        finally:
            os.close(state)
    finally:
        os.close(config)


if __name__ == "__main__":
    try:
        main()
    except (Blocked, OSError, ValueError, TypeError, KeyError) as error:
        code = str(error) if isinstance(error, Blocked) else "REVIEW_REQUIRED"
        print("POLICY_RENEWAL=BLOCKED:" + code)
        sys.exit(2)
    finally:
        print("PRIVATE_KEY_READ=NO SIGNING=NOT_ATTEMPTED PRODUCTION_MUTATION=NONE")
