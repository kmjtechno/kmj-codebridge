#!/usr/bin/env python3
"""KMJ CodeBridge: bounded read-only Supervisor/source parity diagnostic.

This tool never restarts services, installs code, opens the Supervisor socket,
reads gateway secrets, or treats a source SHA as an authenticated RPC result.
The actual privileged operation must be tested separately.
"""
import hashlib
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys

SHA = "40655678db7fa62edca28ccc4988614010253ef1"
STAGES = Path("/opt/kmj-codebridge-supervisor-stage")
SERVICE = "kmj-codebridge-supervisor.service"
SOCKET = "kmj-codebridge-supervisor.socket"
SERVICE_FILE = "/etc/systemd/system/" + SERVICE
SOCKET_FILE = "/etc/systemd/system/" + SOCKET
STAGE_FILES = ("package-lock.json", "src/cli.js", "src/supervisor.js")
SYSTEMCTL = "/usr/bin/systemctl"
PROPERTIES = ("LoadState", "ActiveState", "FragmentPath", "WorkingDirectory",
              "ExecStart", "NeedDaemonReload", "User", "DropInPaths")


def properties(raw):
    out = {}
    for line in raw.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in PROPERTIES and key not in out:
            out[key] = value
    return out


def show(unit):
    # Fixed unit names only. Never interpolate user CLI paths or shell input.
    if unit not in (SERVICE, SOCKET):
        raise ValueError("UNIT_NOT_ALLOWLISTED")
    cmd = [SYSTEMCTL, "show", "--no-pager"]
    for name in PROPERTIES:
        cmd.extend(["-p", name])
    cmd.append(unit)
    proc = subprocess.run(cmd, capture_output=True, timeout=12, check=False)
    if proc.returncode or len(proc.stdout) > 32768:
        raise ValueError("SYSTEMD_READ_FAILED")
    return properties(proc.stdout.decode("utf-8", "replace"))


def trusted_regular(path):
    st = os.lstat(path)
    return (stat.S_ISREG(st.st_mode) and st.st_uid == 0 and
            st.st_nlink == 1 and (st.st_mode & 0o022) == 0 and
            0 < st.st_size <= 1024 * 1024)


def trusted_dir(path):
    st = os.lstat(path)
    return (stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and
            (st.st_mode & 0o022) == 0)


def stage_attestation(base=STAGES, revision=SHA):
    """A bounded installed-stage fingerprint check, NOT full release signing."""
    try:
        stage = base / revision
        if not trusted_dir(base) or not trusted_dir(stage) or not trusted_dir(stage / "src"):
            return "STAGE_PATH_UNTRUSTED"
        marker = stage / ".supervisor-stage"
        files = [stage / item for item in STAGE_FILES]
        if not all(trusted_regular(p) for p in [marker, *files]):
            return "STAGE_FILE_UNTRUSTED"
        # Bounded marker; never follow a symlink or print its raw contents.
        if os.lstat(marker).st_size > 256:
            return "STAGE_MARKER_INVALID"
        expected = revision + ":" + ":".join(
            hashlib.sha256(p.read_bytes()).hexdigest() for p in files
        )
        if marker.read_text("ascii").strip() != expected:
            return "STAGE_FINGERPRINT_MISMATCH"
        return "STAGE_FINGERPRINT_MATCH"
    except (OSError, UnicodeError, ValueError):
        return "STAGE_UNAVAILABLE"


def classify(service, sock, expected_dir=None):
    expected_dir = str(expected_dir or STAGES / SHA)
    if service.get("LoadState") != "loaded" or sock.get("LoadState") != "loaded":
        return "SUPERVISOR_UNIT_MISSING"
    if service.get("FragmentPath") != SERVICE_FILE or sock.get("FragmentPath") != SOCKET_FILE:
        return "SUPERVISOR_UNIT_ORIGIN_UNVERIFIED"
    if service.get("NeedDaemonReload") != "no" or sock.get("NeedDaemonReload") != "no":
        return "SUPERVISOR_DAEMON_RELOAD_PENDING"
    if sock.get("ActiveState") != "active":
        return "SUPERVISOR_SOCKET_INACTIVE"
    if service.get("User") not in ("", "root"):
        return "SUPERVISOR_USER_UNEXPECTED"
    runtime = service.get("WorkingDirectory", "")
    if runtime != expected_dir:
        return "SUPERVISOR_RUNTIME_STALE_OR_UNVERIFIED"
    exe = service.get("ExecStart", "")
    allowed_nodes = ("/opt/kmj-codebridge-node/bin/node", "/usr/bin/node")
    if not any("argv[]=" + node + " " + expected_dir + "/src/cli.js supervisor ;" in exe
               for node in allowed_nodes):
        return "SUPERVISOR_EXEC_MISMATCH"
    return "SERVICE_SOURCE_PATH_MATCH"


def main():
    if sys.argv[1:]:
        print("SUPERVISOR_PARITY=BLOCKED_INVALID_ARGS")
        return 2
    if socket.gethostname().split(".")[0].lower() != "kmj-elite":
        print("SUPERVISOR_PARITY=BLOCKED_WRONG_HOST")
        return 2
    try:
        s, k = show(SERVICE), show(SOCKET)
        status = classify(s, k)
        fingerprint = stage_attestation()
    except (OSError, ValueError, subprocess.TimeoutExpired):
        status, fingerprint = "SYSTEMD_UNAVAILABLE", "NOT_CHECKED"
    print("EXPECTED_SOURCE_SHA=" + SHA)
    print("SUPERVISOR_UNIT_PARITY=" + status)
    print("SUPERVISOR_STAGE_FINGERPRINT=" + fingerprint)
    print("PRIVILEGED_NEW_RPC_CALL=NOT_ATTEMPTED")
    print("BACKUP_OR_HEALTH_OPERATION_VERIFIED=NO")
    print("SYSTEM_MUTATION=NONE")
    return 0 if status == "SERVICE_SOURCE_PATH_MATCH" and fingerprint == "STAGE_FINGERPRINT_MATCH" else 2


if __name__ == "__main__":
    raise SystemExit(main())
