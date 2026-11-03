#!/usr/bin/env python3
"""Strictly read-only host-local trust preflight for pre-existing GCE relay.

Execute only from an ALREADY AUTHORIZED shell on exact existing relay
instance-20260912-094732 (kmj-techno/us-central1-a, 10.128.0.2).
No SSH login/authorization created by this program. No Cloud API writes,
known_hosts updates, firewall changes, VM start/stop, backup copy or secrets.
Do NOT use gcloud compute ssh only for this audit without understanding that
gcloud may install/change SSH keys or instance/project authentication metadata.
"""
from __future__ import annotations

import base64
import binascii
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import urllib.request

PROJECT = "kmj-techno"
ZONE = "us-central1-a"
VM = "instance-20260912-094732"
INTERNAL_IP = "10.128.0.2"
ELITE_IPV4 = "103.212.136.154"
ELITE_EXPECTED_ED25519 = "SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI"
PUBKEY_FILE = Path("/etc/ssh/ssh_host_ed25519_key.pub")
TYPE = "ssh-ed25519"
BASE64_FIELD = re.compile(r"[A-Za-z0-9+/]+={0,2}\Z")
SHA256_FP = re.compile(r"SHA256:[A-Za-z0-9+/]{40,64}\Z")


class Blocked(RuntimeError):
    pass


def metadata(resource: str) -> str:
    if resource not in (
        "instance/name", "instance/zone", "project/project-id",
        "instance/network-interfaces/0/ip",
    ):
        raise Blocked("METADATA_RESOURCE_NOT_ALLOWLISTED")
    url = "http://metadata.google.internal/computeMetadata/v1/" + resource
    request = urllib.request.Request(url, headers={"Metadata-Flavor": "Google"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=5) as result:
            if result.headers.get("Metadata-Flavor") != "Google":
                raise Blocked("GCE_METADATA_FLAVOR_INVALID")
            data = result.read(256)
    except (OSError, TimeoutError) as exc:
        raise Blocked("GCE_METADATA_UNAVAILABLE") from exc
    return data.decode("utf-8").strip()


def run(argv: list[str], *, stdin: str | None = None, seconds: int = 12) -> str:
    try:
        proc = subprocess.run(
            argv, input=stdin, capture_output=True, text=True,
            check=False, timeout=seconds,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Blocked("LOCAL_READONLY_COMMAND_UNAVAILABLE_OR_TIMEOUT") from exc
    if proc.returncode != 0 or len(proc.stdout.encode("utf-8")) > 16384:
        raise Blocked("LOCAL_READONLY_COMMAND_FAILED")
    return proc.stdout.strip()


def parse_scan(scan: str, expected_host: str) -> str:
    if len(scan.encode("utf-8")) > 16384:
        raise Blocked("SSH_KEYSCAN_OVERSIZE")
    lines = [row.strip() for row in scan.splitlines()
             if row.strip() and not row.lstrip().startswith("#")]
    if len(lines) != 1:
        raise Blocked("EXPECTED_EXACTLY_ONE_ELITE_ED25519_KEY")
    parts = lines[0].split()
    if (len(parts) != 3 or parts[0] != expected_host
            or parts[1] != TYPE or len(parts[2]) > 2048
            or not BASE64_FIELD.fullmatch(parts[2])):
        raise Blocked("REMOTE_HOST_OR_ALGORITHM_MISMATCH")
    try:
        raw = base64.b64decode(parts[2], validate=True)
    except (ValueError, binascii.Error) as exc:
        raise Blocked("REMOTE_PUBLIC_KEY_INVALID") from exc
    if not (40 <= len(raw) <= 1024):
        raise Blocked("REMOTE_PUBLIC_KEY_SIZE_INVALID")
    return lines[0] + "\n"


def parse_fingerprint(output: str) -> str:
    lines = output.splitlines()
    if len(lines) != 1:
        raise Blocked("PUBLIC_FINGERPRINT_RECORD_COUNT_INVALID")
    parts = lines[0].split()
    if len(parts) < 3 or not SHA256_FP.fullmatch(parts[1]):
        raise Blocked("PUBLIC_FINGERPRINT_FORMAT_INVALID")
    return parts[1]


def inspect() -> int:
    if os.geteuid() == 0:
        raise Blocked("REFUSE_ROOT_SHELL")
    if (metadata("instance/name") != VM
            or metadata("project/project-id") != PROJECT
            or not metadata("instance/zone").endswith("/" + ZONE)
            or metadata("instance/network-interfaces/0/ip") != INTERNAL_IP):
        raise Blocked("EXACT_RELAY_GCE_METADATA_MISMATCH")

    print("RELAY_LOCAL_GCE_IDENTITY=EXACT_VERIFIED", flush=True)
    print("RELAY_INTERNAL_IPV4=10.128.0.2_VERIFIED", flush=True)
    if not shutil.which("ssh-keyscan") or not shutil.which("ssh-keygen"):
        raise Blocked("OPENSSH_PUBLIC_KEY_TOOLS_MISSING")

    try:
        st = PUBKEY_FILE.lstat()
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != 0
                or not 60 <= st.st_size <= 2048 or st.st_mode & 0o022):
            raise Blocked("LOCAL_RELAY_PUBLIC_HOST_KEY_UNTRUSTED")
        local_key = PUBKEY_FILE.read_text(encoding="ascii")
        if len(local_key.splitlines()) != 1 or not local_key.startswith(TYPE + " "):
            raise Blocked("LOCAL_RELAY_PUBLIC_KEY_INVALID_FORMAT")
    except (OSError, UnicodeError) as exc:
        raise Blocked("LOCAL_RELAY_PUBLIC_KEY_NOT_ACCESSIBLE") from exc
    relay_fingerprint = parse_fingerprint(
        run(["ssh-keygen", "-l", "-E", "sha256", "-f", str(PUBKEY_FILE)]))
    print("RELAY_LOCAL_ED25519_PUBLIC_HOST_FINGERPRINT=" + relay_fingerprint,
          flush=True)

    # A successful port 22 connection and matching host public key prove only
    # external host identity from this VM, not authorization to upload data.
    scan = run(["ssh-keyscan", "-4", "-T", "5",
                "-p", "22", "-t", TYPE, ELITE_IPV4], seconds=12)
    remote_key = parse_scan(scan, ELITE_IPV4)
    observed = parse_fingerprint(
        run(["ssh-keygen", "-l", "-E", "sha256", "-f", "-"],
            stdin=remote_key, seconds=8))
    if observed != ELITE_EXPECTED_ED25519:
        raise Blocked("ELITE_ED25519_HOST_KEY_FINGERPRINT_MISMATCH")

    print("RELAY_TO_ELITE_SSH22=REACHABLE", flush=True)
    print("RELAY_TO_ELITE_ED25519_PIN=EXACT_MATCH_VERIFIED", flush=True)
    print("ELITE_EXPECTED_FINGERPRINT=" + ELITE_EXPECTED_ED25519, flush=True)
    print("RELAY_TO_ELITE_SSH_LOGIN=NOT_ATTEMPTED", flush=True)
    print("RELAY_SSH_HOST_TRUST_FROM_N2=NOT_YET_VERIFIED", flush=True)
    for name in ("ssh", "rsync", "age", "zstd", "sha256sum"):
        print("RELAY_TOOL_" + name.upper().replace("-", "_") + "=" +
              ("PRESENT" if shutil.which(name) else "MISSING"), flush=True)
    print("RELAY_EXISTING_WORKLOAD_COMPATIBILITY=NOT_VERIFIED", flush=True)
    print("RESTRICTED_BACKUP_UPLOADER=NOT_CONFIGURED_OR_VERIFIED", flush=True)
    print("AGE_OWNER_RECOVERY_KEY_ESCROW=NOT_VERIFIED", flush=True)
    print("CONSISTENT_BOOT_DISK_CAPTURE=NOT_ATTEMPTED", flush=True)
    print("ENCRYPTED_BACKUP_TRANSFER=NOT_ATTEMPTED", flush=True)
    print("INDEPENDENT_DISPOSABLE_RESTORE_AND_ROLLBACK=NOT_VERIFIED", flush=True)
    print("RELAY_HOST_AND_GCE_MUTATIONS=NONE_BY_THIS_PROGRAM", flush=True)
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)
    return 0


def self_test() -> int:
    assert parse_fingerprint("256 " + ELITE_EXPECTED_ED25519 +
                             " test (ED25519)") == ELITE_EXPECTED_ED25519
    fake = base64.b64encode(b"z" * 64).decode("ascii")
    record = ELITE_IPV4 + " ssh-ed25519 " + fake
    assert parse_scan(record, ELITE_IPV4) == record + "\n"
    for wrong in (record + "\n" + record,
                  record.replace(ELITE_IPV4, "8.8.8.8"),
                  record.replace(TYPE, "ssh-rsa"),
                  record.replace(fake, "!!!")):
        try:
            parse_scan(wrong, ELITE_IPV4)
        except Blocked:
            pass
        else:
            raise AssertionError("Unsafe scanned host identity was accepted")
    for wrong in ("256 MD5:abc host (ED25519)",
                  "256 " + "SHA256:AAA" + " host (ED25519)",
                  "256 " + ELITE_EXPECTED_ED25519 + " host (ED25519)\nextra"):
        try:
            parse_fingerprint(wrong)
        except Blocked:
            pass
        else:
            raise AssertionError("Bad fingerprint output was accepted")
    assert ELITE_EXPECTED_ED25519 == (
        "SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI"
    )
    print("RELAY_ELITE_HOSTPIN_OFFLINE_TESTS=PASS")
    return 0


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    if sys.argv[1:] != ["--inspect"]:
        print("USAGE: script.py --inspect")
        return 64
    try:
        return inspect()
    except (Blocked, OSError, UnicodeError) as exc:
        print("RELAY_ELITE_PINNED_EGRESS_AUDIT=BLOCKED")
        if isinstance(exc, Blocked):
            print("RELAY_EGRESS_REASON=" + str(exc)[:110])
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
