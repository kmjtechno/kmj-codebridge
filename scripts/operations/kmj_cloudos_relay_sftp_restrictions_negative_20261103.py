#!/usr/bin/env python3
"""Non-destructive authenticated SSH/SFTP negative checks on exact GCE relay.

The companion PR820 smoke script is checksum-pinned. First prove successful
public-key-only SFTP pwd/ls under the existing chroot, then try:
  - requested shell command: it MUST NOT execute marker output
  - direct-tcpip forwarding to ELITE 127.0.0.1:22: it MUST be prohibited
  - SFTP read/list of /etc outside restricted chroot: MUST be refused

No writes/uploads, no service changes, no SSH credential export. All stdout
and stderr are inspected only in process memory and never printed.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile

BASE = Path(__file__).resolve().parent
SMOKE_FILE = BASE / "kmj_cloudos_relay_elite_sftp_auth_smoke_20261103.py"
SMOKE_SHA256 = "b3224318810bc7fffe28571f7545cbf3de3453ac9220140d750bdc4ce0ec4c1c"
SENTINEL = b"KMJ_CLOUDOS_UNAUTHORIZED_SHELL_EXECUTED_20261103"
BATCH_CHROOT = b"pwd\nls /etc\n"
HOST = "elite-ssh.kmjtechno.com"
USER = "kmjcloudosbackup"


class Blocked(RuntimeError):
    pass


def load_pinned_smoke():
    st = SMOKE_FILE.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022:
        raise Blocked("COMPANION_SOURCE_PERMISSIONS_UNTRUSTED")
    raw = SMOKE_FILE.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SMOKE_SHA256:
        raise Blocked("COMPANION_SOURCE_SHA256_MISMATCH")
    spec = importlib.util.spec_from_file_location("kmj_pinned_sftp_smoke", SMOKE_FILE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def args(smoke, private, host_pin_file):
    return [
        "-F", "/dev/null",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ConnectionAttempts=1",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=" + host_pin_file,
        "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "HostKeyAlgorithms=ssh-ed25519",
        "-o", "PubkeyAcceptedAlgorithms=ssh-ed25519",
        "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no",
        "-o", "PreferredAuthentications=publickey",
        "-o", "IdentitiesOnly=yes",
        "-o", "IdentityAgent=none",
        "-i", str(private),
        "-p", "22",
    ]


def evaluate_shell(process):
    if SENTINEL in process.stdout or SENTINEL in process.stderr:
        raise Blocked("RESTRICTED_UPLOADER_SHELL_WAS_EXECUTED")
    # A forced SFTP subsystem may close cleanly or with an error. We only
    # claim the requested command was not executed, not global shell security.
    return True


def evaluate_forward(process):
    if b"SSH-" in process.stdout or process.returncode == 0:
        raise Blocked("RESTRICTED_UPLOADER_DIRECT_TCPIP_FORWARD_WAS_ALLOWED")
    if b"administratively prohibited" not in process.stderr.lower():
        raise Blocked("TCPIP_FORWARD_DENIAL_REASON_NOT_VERIFIED")
    return True


def evaluate_chroot(process):
    if process.returncode == 0:
        raise Blocked("SFTP_OUTSIDE_CHROOT_PATH_WAS_LISTABLE")
    if b"Remote working directory:" not in process.stdout:
        raise Blocked("SFTP_AUTH_AND_PWD_PROOF_ABSENT")
    if b"/incoming" not in process.stdout:
        raise Blocked("SFTP_CHROOT_WORKDIR_UNEXPECTED")
    return True


def test():
    smoke = load_pinned_smoke()
    private = smoke.read_local_identity()   # exact GCE metadata, nonroot uid, 0600 key
    host = smoke.pin_remote_host()          # trusted owner-attested ED25519 pin
    smoke.actual_sftp(private, host)        # authenticated read-only positive control

    # The only temporary file contains an independently checked public host
    # key; OpenSSH receives it through StrictHostKeyChecking=yes.
    with tempfile.NamedTemporaryFile(
        mode="w+b", prefix="kmj-cloudos-sftp-neg-pin-",
        suffix=".known_hosts", dir="/tmp", delete=True
    ) as pinned:
        pinned.write(host)
        pinned.flush()
        os.fsync(pinned.fileno())
        options = args(smoke, private, pinned.name)
        destination = USER + "@" + HOST

        shell = smoke.run(
            ["/usr/bin/ssh", "-T", *options, destination,
             "printf " + SENTINEL.decode("ascii")],
            stdin=b"", timeout=22)
        evaluate_shell(shell)
        print("RELAY_SFTP_SHELL_EXECUTION_NEGATIVE=PASS", flush=True)

        # ssh -W opens a direct-tcpip channel: it is expected to fail with
        # administrative prohibition before it connects to the SSH listener.
        forward = smoke.run(
            ["/usr/bin/ssh", "-W", "127.0.0.1:22", *options, destination],
            stdin=b"", timeout=22)
        evaluate_forward(forward)
        print("RELAY_SFTP_DIRECT_TCPIP_FORWARD_NEGATIVE=PASS", flush=True)

        chroot = smoke.run([
            smoke.SFTP,
            "-F", "/dev/null",
            "-b", "-",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            "-o", "ConnectionAttempts=1",
            "-o", "StrictHostKeyChecking=yes",
            "-o", "UserKnownHostsFile=" + pinned.name,
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
            destination,
        ], stdin=BATCH_CHROOT, timeout=25)
        evaluate_chroot(chroot)
        print("RELAY_SFTP_CHROOT_EXTERNAL_PATH_NEGATIVE=PASS", flush=True)

    print("RELAY_TO_ELITE_SFTP_RESTRICTION_NEGATIVES=PASS", flush=True)
    print("RELAY_SFTP_CANARY_WRITE_DELETE=NOT_ATTEMPTED", flush=True)
    print("OWNER_AGE_RECOVERY_AND_N2_RESTORE=NOT_VERIFIED", flush=True)
    print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)


def self_test():
    from types import SimpleNamespace
    try:
        evaluate_shell(SimpleNamespace(stdout=SENTINEL, stderr=b"", returncode=0))
    except Blocked:
        pass
    else:
        raise AssertionError("SHELL_EXECUTION_FALSE_PASS")
    assert evaluate_shell(SimpleNamespace(stdout=b"", stderr=b"", returncode=255))
    for x in (
        SimpleNamespace(stdout=b"SSH-2.0-OpenSSH_9.6\n", stderr=b"", returncode=255),
        SimpleNamespace(stdout=b"", stderr=b"", returncode=0),
        SimpleNamespace(stdout=b"", stderr=b"Permission denied", returncode=255),
    ):
        try:
            evaluate_forward(x)
        except Blocked:
            pass
        else:
            raise AssertionError("FORWARDING_FALSE_PASS")
    assert evaluate_forward(SimpleNamespace(
        stdout=b"", stderr=b"channel 0: open failed: administratively prohibited: open failed",
        returncode=255))
    for x in (
        SimpleNamespace(stdout=b"Remote working directory: /incoming\n", returncode=0),
        SimpleNamespace(stdout=b"", returncode=1),
    ):
        try:
            evaluate_chroot(x)
        except Blocked:
            pass
        else:
            raise AssertionError("CHROOT_FALSE_PASS")
    assert evaluate_chroot(SimpleNamespace(
        stdout=b"Remote working directory: /incoming\n", returncode=1))
    assert BATCH_CHROOT == b"pwd\nls /etc\n"
    print("RELAY_SFTP_NEGATIVE_OFFLINE_TESTS=PASS", flush=True)


def main():
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if sys.argv[1:] != ["--test"]:
        print("USAGE: script --self-test | --test")
        return 64
    try:
        test()
        return 0
    except (Blocked, OSError, UnicodeError, ValueError) as exc:
        print("RELAY_TO_ELITE_SFTP_RESTRICTION_NEGATIVES=BLOCKED", flush=True)
        print("RELAY_NEGATIVE_REASON=" +
              (str(exc)[:90] if isinstance(exc, Blocked)
               else "RUNTIME_OR_LOCAL_FILE_ERROR"), flush=True)
        print("RELAY_SFTP_PRIVATE_KEY=NEVER_EXPORTED", flush=True)
        print("CLOUDOS_PRODUCTION_RELEASE=BLOCKED", flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
