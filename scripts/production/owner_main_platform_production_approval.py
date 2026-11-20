#!/usr/bin/env python3
"""KMJ-elite owner-root ONE-CLICK: write the Main Platform PRODUCTION release approval.

Default is a DRY RUN that checks the real host and prints the approval it WOULD write.
Writing needs ALL of: --apply --attest-backup --attest-rollback. The two *Verified fields
are true only because the owner passes the matching flag; this tool never sets them itself.

What it verifies on the host (and what it does not):
  verified   live release is exactly the pinned predecessor; the candidate release exists,
             is not group/world writable, has apps/platform/storage as the approved shared
             link and a private regular .env; build artifacts present; the local pre-deploy
             backup witness binds this exact SHA, the live release and the archive digest.
  NOT here   the disposable restore result itself (printed by the reviewed recovery script),
             the physical rollback (the fixed activation controller performs and verifies an
             automatic rollback if activation or health fails; the isolated CI rehearsal is
             the only prior evidence), customer-facing QA.

It does NOT activate anything, start a unit, move current/previous, touch staging, the
database, DNS, Google/offsite or the network, and runs no command. An existing approval is
backed up to /root before it is replaced. Activation is a separate Supervisor step.

  python3 -I owner_main_platform_production_approval.py --sha=<40hex> --live=platform-<12hex>          # dry run
  python3 -I owner_main_platform_production_approval.py --sha=<40hex> --live=platform-<12hex> --apply --attest-backup --attest-rollback
"""
import hashlib
import json
import os
import re
import socket
import stat
import sys
import time

# Explicit owner inputs (never inferred from the network): --sha=<40 hex> --live=platform-<12 hex>.
# They are set once by configure() before any host check and are then bound to the real host state:
# the live pointer must equal --live, the candidate must be platform-<sha12>, and the backup witness
# must name exactly this SHA, this live release and the archive digest.
SHA40 = re.compile(r"[a-f0-9]{40}\Z")
LIVE12 = re.compile(r"platform-[a-f0-9]{12}\Z")
APPROVED = SHORT = LIVE_RELEASE = CANDIDATE = WITNESS = ARCHIVE = None

ROOT = "/home/kmjprod"
PROD_LINK = ROOT + "/current"
SHARED = ROOT + "/shared/storage"
APPROVAL = "/etc/kmj-codebridge/main-platform-production-release.json"
BACKUP_DIR = "/root"

FLAGS = ("--attest-backup", "--attest-rollback")
SHA64 = re.compile(r"[a-f0-9]{64}\Z")


class Blocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Blocked(code)


def configure(sha, live):
    global APPROVED, SHORT, LIVE_RELEASE, CANDIDATE, WITNESS, ARCHIVE
    require(isinstance(sha, str) and SHA40.match(sha) is not None, "SHA_INVALID")
    require(isinstance(live, str) and LIVE12.match(live) is not None, "LIVE_RELEASE_INVALID")
    require(live != "platform-" + sha[:12], "TARGET_EQUALS_LIVE")
    APPROVED, SHORT, LIVE_RELEASE = sha, sha[:12], live
    CANDIDATE = ROOT + "/releases/platform-" + SHORT
    WITNESS = "/var/backups/kmj-platform/pre-deploy-" + SHORT + ".json"
    ARCHIVE = "/var/backups/kmj-platform/pre-deploy-" + SHORT + ".tar.gz"


def parse_args(argv):
    """Returns (apply, attested). Requires --sha=... and --live=...; configures the module."""
    values, flags = {}, []
    for arg in argv:
        if arg.startswith(("--sha=", "--live=")):
            key, _, val = arg.partition("=")
            require(key not in values, "UNKNOWN_OR_DUPLICATE_ARGUMENT")
            values[key] = val
        else:
            flags.append(arg)
    known = {"--apply", *FLAGS}
    seen = set(flags)
    require(len(flags) == len(seen) and seen <= known, "UNKNOWN_OR_DUPLICATE_ARGUMENT")
    require(set(values) == {"--sha", "--live"}, "SHA_AND_LIVE_REQUIRED")
    configure(values["--sha"], values["--live"])
    given = seen & set(FLAGS)
    if "--apply" in seen:
        require(given == set(FLAGS), "APPLY_REQUIRES_BOTH_ATTEST_FLAGS")
        return True, True
    require(not given, "ATTEST_FLAGS_REQUIRE_APPLY")
    return False, False


def build_approval(attested):
    flag = bool(attested)
    # Exactly the four keys the Supervisor and the activation controller accept.
    return {
        "approvedSha": APPROVED,
        "expectedCurrentRelease": LIVE_RELEASE,
        "backupVerified": flag,
        "rollbackVerified": flag,
    }


def render(record):
    return (json.dumps(record, indent=2, sort_keys=True) + "\n").encode("ascii")


def _unique(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, "DUPLICATE_KEY")
        out[key] = value
    return out


def check_witness(witness_bytes, archive_sha256):
    try:
        record = json.loads(witness_bytes.decode("utf-8"), object_pairs_hook=_unique)
    except (ValueError, UnicodeError, Blocked):
        raise Blocked("WITNESS_UNREADABLE") from None
    require(isinstance(record, dict) and set(record) == {"approvedSha", "currentRelease", "backupSha256"}, "WITNESS_KEYS")
    require(record["approvedSha"] == APPROVED, "WITNESS_SHA_MISMATCH")
    require(record["currentRelease"] == LIVE_RELEASE, "WITNESS_RELEASE_MISMATCH")
    require(isinstance(record["backupSha256"], str) and SHA64.match(record["backupSha256"]) is not None, "WITNESS_DIGEST_FORMAT")
    require(record["backupSha256"] == archive_sha256, "WITNESS_ARCHIVE_DIGEST_MISMATCH")


def root_regular(path, maximum, private=False):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise Blocked("FILE_MISSING_OR_LINK:" + os.path.basename(path)) from None
    try:
        st = os.fstat(fd)
        mask = 0o077 if private else 0o022
        require(
            stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1
            and not st.st_mode & mask and 0 < st.st_size <= maximum,
            "FILE_UNSAFE:" + os.path.basename(path),
        )
        h = hashlib.sha256()
        head = b""
        with os.fdopen(os.dup(fd), "rb") as src:
            while True:
                data = src.read(1024 * 1024)
                if not data:
                    break
                h.update(data)
                if len(head) < 1024 * 1024:
                    head += data
        return h.hexdigest(), head if st.st_size <= 1024 * 1024 else b""
    finally:
        os.close(fd)


def root_dir(path):
    try:
        st = os.lstat(path)
    except OSError:
        raise Blocked("DIR_MISSING:" + path) from None
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022, "DIR_UNSAFE:" + path)


def candidate_checks():
    try:
        st = os.lstat(CANDIDATE)
    except OSError:
        raise Blocked("CANDIDATE_MISSING") from None
    require(stat.S_ISDIR(st.st_mode) and not st.st_mode & 0o022, "CANDIDATE_UNSAFE")
    require(os.path.isdir(CANDIDATE + "/.git") and not os.path.islink(CANDIDATE + "/.git"), "CANDIDATE_GIT_MISSING")
    storage = CANDIDATE + "/apps/platform/storage"
    require(os.path.islink(storage) and os.path.realpath(storage) == SHARED, "CANDIDATE_STORAGE_NOT_SHARED")
    env = os.lstat(CANDIDATE + "/apps/platform/.env") if os.path.lexists(CANDIDATE + "/apps/platform/.env") else None
    require(env is not None and stat.S_ISREG(env.st_mode) and not env.st_mode & 0o077, "CANDIDATE_ENV_MISSING_OR_OPEN")
    for item in ("artisan", "vendor/autoload.php", "public/build/manifest.json"):
        path = CANDIDATE + "/apps/platform/" + item
        require(os.path.isfile(path) and not os.path.islink(path) and os.path.getsize(path) > 0, "CANDIDATE_ARTIFACT_MISSING")


def inspect_host():
    require(getattr(os, "geteuid", lambda: 1)() == 0, "NOT_ROOT")
    require(socket.gethostname().split(".")[0].lower() == "kmj-elite", "WRONG_HOST")
    require(os.path.islink(PROD_LINK) and os.path.realpath(PROD_LINK) == ROOT + "/releases/" + LIVE_RELEASE, "LIVE_RELEASE_MISMATCH")
    require(os.path.basename(os.path.realpath(PROD_LINK)) != "platform-" + SHORT, "TARGET_ALREADY_LIVE")
    candidate_checks()
    archive_sha, _ = root_regular(ARCHIVE, 20 * 1024 ** 3, private=True)
    _d, witness = root_regular(WITNESS, 4096, private=True)
    check_witness(witness, archive_sha)
    root_dir(os.path.dirname(APPROVAL))


def write_approval(content):
    existing = None
    if os.path.lexists(APPROVAL):
        _d, existing = root_regular(APPROVAL, 4096)
        if existing == content:
            return "ALREADY_PRESENT_IDENTICAL"
        backup = BACKUP_DIR + "/mp-production-approval-backup-" + str(int(time.time())) + ".json"
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as out:
            out.write(existing)
            out.flush()
            os.fsync(out.fileno())
    tmp = APPROVAL + ".tmp-" + str(os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, APPROVAL)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    dfd = os.open(os.path.dirname(APPROVAL), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)
    return "REPLACED_PREVIOUS_BACKED_UP" if existing is not None else "WRITTEN"


def main(argv):
    try:
        apply, attested = parse_args(argv)
        inspect_host()
        content = render(build_approval(attested))
        print("MP_PRODUCTION_APPROVAL_HOST_CHECKS=PASS")
        print("APPROVED_SHA=" + APPROVED)
        print("EXPECTED_CURRENT_RELEASE=" + LIVE_RELEASE)
        print("BACKUP_WITNESS=VERIFIED_HERE_LOCAL_ARCHIVE_BOUND_TO_EXACT_SHA")
        print("CANDIDATE=VERIFIED_SHARED_STORAGE_PRIVATE_ENV_ARTIFACTS_PRESENT")
        print("ROLLBACK_BASIS=CI_REHEARSAL_PLUS_AUTOMATIC_CONTROLLER_ROLLBACK_NOT_PHYSICAL_DRILL")
        print("STAGING_EXACT_SHA_TEST=NOT_PERFORMED")
        if not apply:
            print(content.decode("ascii"), end="")
            print("MP_PRODUCTION_APPROVAL=DRY_RUN_NOTHING_WRITTEN")
            return 0
        print("MP_PRODUCTION_APPROVAL=" + write_approval(content))
        print("PRODUCTION_ACTIVATION=NOT_STARTED")
        print("CURRENT_POINTER=UNCHANGED")
        return 0
    except Blocked as exc:
        print("MP_PRODUCTION_APPROVAL=BLOCKED_" + str(exc))
        print("NOTHING_ACTIVATED")
        return 2
    except OSError:
        print("MP_PRODUCTION_APPROVAL=BLOCKED_OPERATOR_FAILURE")
        print("NOTHING_ACTIVATED")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
