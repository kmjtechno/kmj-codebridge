#!/usr/bin/env python3
"""Non-mutating external SSH host-key check for the known KMJ-elite receiver.

Execute from Cloud Shell (or any external operator host) as:
    python3 cloudos_elite_ssh_trust_probe_20261102.py --probe EXISTING_ELITE_PUBLIC_IPV4

This never logs in, transfers data, writes known_hosts, starts N2, changes
firewalls, creates costs/resources, or grants recovery/release credit.
A matching remote ED25519 key is ONLY a verified host trust candidate;
authorized user login and N2->ELITE reachability are separate gates.
"""
from __future__ import annotations

import base64
import ipaddress
import re
import subprocess
import sys

EXPECTED_FINGERPRINT = "SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI"
KEYTYPE = "ssh-ed25519"
HOST_KEY_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


class Blocked(Exception):
    pass


def require_public_ipv4(raw: object) -> str:
    if not isinstance(raw, str) or len(raw) > 45:
        raise Blocked("INVALID_ENDPOINT")
    try:
        value = ipaddress.IPv4Address(raw)
    except (ValueError, ipaddress.AddressValueError) as exc:
        raise Blocked("INVALID_ENDPOINT") from exc
    if not value.is_global or str(value) != raw:
        raise Blocked("ENDPOINT_NOT_CANONICAL_GLOBAL_IPV4")
    return str(value)


def parse_keyscan(output: str, host: str) -> str:
    if len(output.encode("utf-8")) > 16384:
        raise Blocked("HOSTKEY_SCAN_OVERSIZE")
    lines = [ln.strip() for ln in output.splitlines()
             if ln.strip() and not ln.lstrip().startswith("#")]
    if len(lines) != 1:
        raise Blocked("EXPECTED_ONE_ED25519_HOST_KEY")
    parts = lines[0].split()
    if (len(parts) != 3 or parts[0] != host
            or parts[1] != KEYTYPE
            or not HOST_KEY_RE.fullmatch(parts[2])
            or len(parts[2]) > 2048):
        raise Blocked("UNEXPECTED_HOST_OR_KEY_TYPE")
    try:
        raw = base64.b64decode(parts[2], validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise Blocked("INVALID_HOST_PUBLIC_KEY") from exc
    if not (40 <= len(raw) <= 1024):
        raise Blocked("INVALID_HOST_PUBLIC_KEY_SIZE")
    return lines[0] + "\n"


def run(argv: list[str], *, stdin: str | None = None, timeout: int = 12) -> str:
    try:
        p = subprocess.run(
            argv, input=stdin, capture_output=True, text=True,
            timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Blocked("SSH_PROBE_COMMAND_UNAVAILABLE_OR_TIMEOUT") from exc
    if p.returncode or len(p.stdout.encode()) > 16384:
        raise Blocked("SSH_PROBE_COMMAND_FAILED")
    return p.stdout.strip()


def check(host: str, command=run) -> None:
    host = require_public_ipv4(host)
    scan = command(["ssh-keyscan", "-4", "-T", "5",
                    "-p", "22", "-t", KEYTYPE, host], timeout=11)
    verified_key = parse_keyscan(scan, host)
    output = command(["ssh-keygen", "-l", "-E", "sha256", "-f", "-"],
                     stdin=verified_key, timeout=8)
    lines = output.splitlines()
    if len(lines) != 1:
        raise Blocked("SSH_KEYGEN_FINGERPRINT_UNAVAILABLE")
    parts = lines[0].split()
    if len(parts) < 3 or parts[1] != EXPECTED_FINGERPRINT:
        raise Blocked("ELITE_ED25519_HOST_FINGERPRINT_MISMATCH")
    print("ELITE_EXTERNAL_SSH22=REACHABLE")
    print("ELITE_HOST_ED25519_FINGERPRINT=PINNED_MATCH_VERIFIED")
    print("ELITE_HOST_ED25519_EXPECTED=" + EXPECTED_FINGERPRINT)
    print("ELITE_HOST_KEY_SCAN=READ_ONLY_NO_KNOWN_HOSTS_WRITE")
    print("CLOUD_SHELL_TO_ELITE_REACHABILITY=PASS")
    print("N2_TO_ELITE_REACHABILITY=NOT_TESTED")
    print("ELITE_SSH_LOGIN_AUTHORIZATION=NOT_TESTED")
    print("RESTRICTED_UPLOAD_IDENTITY=NOT_VERIFIED")
    print("OFFSITE_AGE_RECIPIENT_ESCROW=NOT_VERIFIED")
    print("ENCRYPTED_BACKUP_TRANSFER=NOT_ATTEMPTED")
    print("INDEPENDENT_BOOT_RESTORE_AND_ROLLBACK=NOT_VERIFIED")
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")


def self_test() -> None:
    assert require_public_ipv4("103.212.136.154") == "103.212.136.154"
    for invalid in ("127.0.0.1", "10.128.0.3", "192.168.1.1",
                    "103.212.136.154;id", "103.212.136.154\n",
                    "http://103.212.136.154", "1.1.1.01", "::1"):
        try:
            require_public_ipv4(invalid)
        except Blocked:
            pass
        else:
            raise AssertionError("Unsafe endpoint accepted: " + invalid)
    key = base64.b64encode(b"x" * 60).decode()
    data = "103.212.136.154 ssh-ed25519 " + key
    assert parse_keyscan(data, "103.212.136.154").strip() == data
    for invalid in (data + "\n" + data,
                    data.replace("ssh-ed25519", "ssh-rsa"),
                    data.replace("103.212.136.154", "8.8.8.8"),
                    data.replace(key, "!!!!")):
        try:
            parse_keyscan(invalid, "103.212.136.154")
        except Blocked:
            pass
        else:
            raise AssertionError("Untrusted host key accepted")
    calls = []
    def fake(argv, *, stdin=None, timeout=12):
        calls.append(argv[:])
        if argv[0] == "ssh-keyscan":
            return data
        if argv[0] == "ssh-keygen":
            assert stdin == data + "\n"
            return "256 " + EXPECTED_FINGERPRINT + " host (ED25519)"
        raise AssertionError("Unexpected command")
    check("103.212.136.154", command=fake)
    assert [a[0] for a in calls] == ["ssh-keyscan", "ssh-keygen"]
    def wrong(argv, *, stdin=None, timeout=12):
        if argv[0] == "ssh-keyscan":
            return data
        return "256 SHA256:" + "a"*43 + " host (ED25519)"
    try:
        check("103.212.136.154", command=wrong)
    except Blocked:
        pass
    else:
        raise AssertionError("Mismatched host fingerprint accepted")
    print("ELITE_EXTERNAL_SSH_TRUST_OFFLINE_TESTS=PASS")


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if len(sys.argv) != 3 or sys.argv[1] != "--probe":
        print("USAGE: script.py --probe KNOWN_ELITE_PUBLIC_IPV4")
        return 64
    try:
        check(sys.argv[2])
        return 0
    except Blocked as err:
        print("ELITE_EXTERNAL_SSH_TRUST_PROBE=BLOCKED_" + str(err))
        print("N2_TO_ELITE_REACHABILITY=NOT_TESTED")
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
