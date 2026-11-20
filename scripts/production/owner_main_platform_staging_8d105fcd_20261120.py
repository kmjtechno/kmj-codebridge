#!/usr/bin/env python3
"""KMJ-elite owner-root ONE-CLICK: write the Main Platform STAGING approval for one exact SHA.

Default is a DRY RUN that checks the real host evidence and prints the approval it
WOULD write; nothing is changed. Writing requires ALL of these explicit owner flags:

  --apply --attest-backup --attest-rollback --attest-storage --attest-zero-cost

The four *Verified fields in the approval are `true` ONLY because the owner passes the
matching --attest-* flag; this tool never sets them by itself, and it never runs without
--apply. It verifies what it can on the host and prints exactly what each attestation
rests on, so the owner is attesting knowingly:

  backup     verified here: local pre-deploy witness + archive SHA-256 for this exact SHA
             (the disposable PostgreSQL restore result itself is NOT re-checked here)
  rollback   NOT verified here: rests on the isolated CI rehearsal, not a physical Elite switch
  storage    NOT verified here: owner judgement
  zero-cost  NOT verified here: owner judgement (Elite-only, no new paid service)

It does NOT deploy, start a unit, move a staging/production pointer, touch production
approval, DNS, Google/offsite, or any secret. Exact SHA, live release and the installed
runner/unit digests are pinned in this file; any drift blocks.

  python3 -I owner_main_platform_staging_8d105fcd_20261120.py                 # dry run
  python3 -I owner_main_platform_staging_8d105fcd_20261120.py --apply --attest-backup \\
      --attest-rollback --attest-storage --attest-zero-cost
"""
import hashlib
import json
import os
import re
import socket
import stat
import sys
import time

APPROVED = "8d105fcd41d0b4bb744e8843b5e1200f7d7381fe"
SHORT = APPROVED[:12]
LIVE_RELEASE = "platform-98bd75b69135"
RUNNER_SHA = "9713b608e2cd8c8c9f0ad4f56e475f035b86bf889ef0cc164f9aa9532ad2d7ab"
UNIT_SHA = "21e8566433cfbb7c86864844df68295fb1dd420b87ec21aa541a35a1656c9919"

RUNNER = "/usr/local/libexec/kmj-codebridge/kmj-main-platform-staging-deploy.sh"
UNIT = "/etc/systemd/system/kmj-main-platform-staging-deploy.service"
APPROVAL = "/etc/kmj-codebridge/main-platform-staging-approval.json"
SEAL = "/etc/kmj-codebridge/main-platform-staging-seal-" + APPROVED + ".sha256"
STAGE_LINK = "/home/kmjstage/htdocs/staging.kmjtechno.com"
STAGE_RELEASES = "/home/kmjstage/releases"
PROD_LINK = "/home/kmjprod/current"
WITNESS = "/var/backups/kmj-platform/pre-deploy-" + SHORT + ".json"
ARCHIVE = "/var/backups/kmj-platform/pre-deploy-" + SHORT + ".tar.gz"
BACKUP_DIR = "/root"

FLAGS = ("--attest-backup", "--attest-rollback", "--attest-storage", "--attest-zero-cost")
SHA40 = re.compile(r"[a-f0-9]{40}\Z")
SHA64 = re.compile(r"[a-f0-9]{64}\Z")


class Blocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Blocked(code)


def parse_args(argv):
    """Returns (apply, attested). Any unknown/partial combination is blocked."""
    known = {"--apply", *FLAGS}
    seen = set(argv)
    require(len(argv) == len(seen) and seen <= known, "UNKNOWN_OR_DUPLICATE_ARGUMENT")
    flags = seen & set(FLAGS)
    if "--apply" in seen:
        require(flags == set(FLAGS), "APPLY_REQUIRES_ALL_FOUR_ATTEST_FLAGS")
        return True, True
    require(not flags, "ATTEST_FLAGS_REQUIRE_APPLY")
    return False, False


def build_approval(expected_current, attested):
    require(SHA40.match(expected_current) is not None and expected_current != APPROVED, "EXPECTED_CURRENT_INVALID")
    flag = bool(attested)
    return {
        "schema": "kmj.main-platform.staging-approval.v1",
        "approvedSha": APPROVED,
        "expectedCurrentSha": expected_current,
        "expectedProductionRelease": LIVE_RELEASE,
        "runnerSha256": RUNNER_SHA,
        "unitSha256": UNIT_SHA,
        "backupVerified": flag,
        "rollbackVerified": flag,
        "storageVerified": flag,
        "zeroAdditionalCostVerified": flag,
    }


def render(record):
    return (json.dumps(record, indent=2, sort_keys=True) + "\n").encode("ascii")


def check_witness(witness_bytes, archive_sha256):
    """Pure: the root-only witness must bind this exact SHA, the live release and the archive digest."""
    try:
        record = json.loads(witness_bytes.decode("utf-8"), object_pairs_hook=_unique)
    except (ValueError, UnicodeError, Blocked):
        raise Blocked("WITNESS_UNREADABLE") from None
    require(isinstance(record, dict) and set(record) == {"approvedSha", "currentRelease", "backupSha256"}, "WITNESS_KEYS")
    require(record["approvedSha"] == APPROVED, "WITNESS_SHA_MISMATCH")
    require(record["currentRelease"] == LIVE_RELEASE, "WITNESS_RELEASE_MISMATCH")
    require(isinstance(record["backupSha256"], str) and SHA64.match(record["backupSha256"]) is not None, "WITNESS_DIGEST_FORMAT")
    require(record["backupSha256"] == archive_sha256, "WITNESS_ARCHIVE_DIGEST_MISMATCH")


def _unique(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, "DUPLICATE_KEY")
        out[key] = value
    return out


def root_regular(path, maximum, private=False):
    """Open without following links; root-owned single-link regular file, not group/other writable."""
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
        chunks = []
        with os.fdopen(os.dup(fd), "rb") as src:
            while True:
                data = src.read(1024 * 1024)
                if not data:
                    break
                h.update(data)
                if len(chunks) < 8:
                    chunks.append(data)
        return h.hexdigest(), b"".join(chunks) if st.st_size <= 1024 * 1024 else b""
    finally:
        os.close(fd)


def root_dir(path):
    try:
        st = os.lstat(path)
    except OSError:
        raise Blocked("DIR_MISSING:" + path) from None
    require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022, "DIR_UNSAFE:" + path)


def inspect_host():
    require(getattr(os, "geteuid", lambda: 1)() == 0, "NOT_ROOT")
    require(socket.gethostname().split(".")[0].lower() == "kmj-elite", "WRONG_HOST")
    # Live production must still be exactly the pinned predecessor.
    require(os.path.realpath(PROD_LINK) == "/home/kmjprod/releases/" + LIVE_RELEASE, "LIVE_RELEASE_MISMATCH")
    # Current staging pointer is the expected-current of the approval.
    require(os.path.islink(STAGE_LINK), "STAGING_POINTER_MISSING")
    target = os.path.realpath(STAGE_LINK)
    m = re.fullmatch(re.escape(STAGE_RELEASES) + r"/([a-f0-9]{40})/apps/platform", target)
    require(m is not None, "STAGING_POINTER_UNEXPECTED")
    expected_current = m.group(1)
    require(expected_current != APPROVED, "STAGING_ALREADY_AT_APPROVED_SHA")
    # Candidate must be the sealed, root-owned tree and a seal digest must exist.
    candidate = STAGE_RELEASES + "/" + APPROVED + "/apps/platform"
    require(not os.path.islink(STAGE_RELEASES + "/" + APPROVED), "CANDIDATE_LINK")
    root_dir(STAGE_RELEASES + "/" + APPROVED)
    root_dir(candidate)
    _digest, seal = root_regular(SEAL, 256)
    require(SHA64.match(seal.decode("ascii", "replace").strip()) is not None, "SEAL_FORMAT")
    # Installed runner and unit must be exactly the pinned bytes; no unit drop-ins.
    require(root_regular(RUNNER, 1024 * 1024)[0] == RUNNER_SHA, "RUNNER_DIGEST_MISMATCH")
    require(root_regular(UNIT, 65536)[0] == UNIT_SHA, "UNIT_DIGEST_MISMATCH")
    require(not os.path.lexists(UNIT + ".d"), "UNIT_DROPIN_PRESENT")
    # Local pre-deploy backup witness for this exact SHA.
    archive_sha, _ = root_regular(ARCHIVE, 20 * 1024 ** 3, private=True)
    _d, witness = root_regular(WITNESS, 4096, private=True)
    check_witness(witness, archive_sha)
    root_dir(os.path.dirname(APPROVAL))
    return expected_current


def write_approval(content):
    existing = None
    if os.path.lexists(APPROVAL):
        _d, existing = root_regular(APPROVAL, 4096)
        if existing == content:
            return "ALREADY_PRESENT_IDENTICAL"
        stamp = str(int(time.time()))
        backup = BACKUP_DIR + "/mp-staging-approval-backup-" + stamp + ".json"
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
        expected_current = inspect_host()
        record = build_approval(expected_current, attested)
        content = render(record)
        print("MP_STAGING_APPROVAL_HOST_CHECKS=PASS")
        print("APPROVED_SHA=" + APPROVED)
        print("EXPECTED_CURRENT_STAGING_SHA=" + expected_current)
        print("EXPECTED_PRODUCTION_RELEASE=" + LIVE_RELEASE)
        print("BACKUP_WITNESS=VERIFIED_HERE_LOCAL_ARCHIVE_BOUND_TO_EXACT_SHA")
        print("ROLLBACK_BASIS=ISOLATED_CI_REHEARSAL_NOT_PHYSICAL_ELITE_SWITCH")
        print("STORAGE_BASIS=OWNER_JUDGEMENT_NOT_VERIFIED_HERE")
        print("ZERO_COST_BASIS=OWNER_JUDGEMENT_NOT_VERIFIED_HERE")
        if not apply:
            print(content.decode("ascii"), end="")
            print("MP_STAGING_APPROVAL=DRY_RUN_NOTHING_WRITTEN")
            return 0
        print("MP_STAGING_APPROVAL=" + write_approval(content))
        print("STAGING_DEPLOY=NOT_STARTED")
        print("STAGING_POINTER=UNCHANGED")
        print("PRODUCTION=UNCHANGED_NO_PRODUCTION_APPROVAL_TOUCHED")
        return 0
    except Blocked as exc:
        print("MP_STAGING_APPROVAL=BLOCKED_" + str(exc))
        print("NOTHING_ACTIVATED")
        return 2
    except OSError:
        print("MP_STAGING_APPROVAL=BLOCKED_OPERATOR_FAILURE")
        print("NOTHING_ACTIVATED")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
