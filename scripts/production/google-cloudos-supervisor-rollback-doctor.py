#!/usr/bin/env python3
"""Read-only Google CloudOS Supervisor rollback inventory.

No sudo, network, configuration contents, subprocess shell, unit changes,
file writes or process signals. Does not claim that runtime RPCs passed.
"""
from __future__ import annotations

import os
from pathlib import Path
import socket
import stat
import subprocess
import sys

UNIT_NAMES = (
    "kmj-codebridge-cloudos.service",
    "kmj-cloudos-api.service",
    "kmj-cloudos-worker.service",
    "kmj-codebridge-supervisor.socket",
    "kmj-codebridge-supervisor.service",
)
STAGE_ROOT = Path("/opt/kmj-codebridge-cloudos-supervisor")
OLD_SOURCE = "fa9340b958ce50000298282d65f3132596c16503"
SIGNED_SOURCE = "9584b584c9a94545fb9dc750c9dfef5bf4f7978a"
SOCKET = Path("/run/kmj-codebridge/supervisor.sock")
CONFIG = Path("/home/info/.config/kmj-codebridge/agent.json")


def status(unit: str) -> str:
    if unit not in UNIT_NAMES:
        return "INVALID_UNIT"
    try:
        result = subprocess.run(
            [
                "/usr/bin/systemctl",
                "show",
                unit,
                "--no-pager",
                "--property=LoadState",
                "--property=ActiveState",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=7,
            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"},
        )
    except (OSError, subprocess.TimeoutExpired):
        return "UNAVAILABLE"
    if result.returncode != 0:
        return "UNAVAILABLE"
    fields = dict(
        line.split("=", 1)
        for line in result.stdout.splitlines()
        if "=" in line
    )
    load = fields.get("LoadState")
    active = fields.get("ActiveState")
    if load == "not-found":
        return "NOT_INSTALLED"
    if load != "loaded":
        return "UNKNOWN_LOAD_STATE"
    return active.upper() if active in {"active", "inactive", "failed"} else "UNKNOWN_STATE"


def stage(pin: str) -> str:
    # A safe leaf beneath a redirected or writable parent is not safe.
    for parent in (Path("/"), Path("/opt"), STAGE_ROOT):
        try:
            parent_info = parent.lstat()
        except OSError:
            return "PARENT_UNAVAILABLE"
        if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != 0:
            return "UNSAFE_PARENT_IDENTITY"
        if parent_info.st_mode & 0o022:
            return "UNSAFE_PARENT_PERMISSIONS"
    path = STAGE_ROOT / pin
    try:
        info = path.lstat()
    except FileNotFoundError:
        return "ABSENT"
    except OSError:
        return "UNAVAILABLE"
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
        return "UNSAFE_IDENTITY"
    if info.st_mode & 0o022:
        return "UNSAFE_PERMISSIONS"
    # Presence is not cryptographic source attestation. The stage might be
    # incomplete, and this doctor intentionally never repairs or deletes it.
    return "PRESENT_NOT_ATTESTED"


def config_metadata() -> str:
    try:
        info = CONFIG.lstat()
    except OSError:
        return "UNAVAILABLE"
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        return "IDENTITY_MISMATCH"
    if info.st_mode & 0o077:
        return "PERMISSIONS_UNSAFE"
    return "OWNER_AND_MODE_PASS_CONTENT_UNREAD"


def socket_metadata() -> str:
    try:
        info = SOCKET.lstat()
    except FileNotFoundError:
        return "ABSENT"
    except OSError:
        return "UNAVAILABLE"
    if not stat.S_ISSOCK(info.st_mode):
        return "NOT_SOCKET"
    # Root-owned/group-accessible sockets can be valid. The approved
    # ownership/group/mode contract is not yet available to this doctor.
    if info.st_mode & 0o002:
        return "UNSAFE_WORLD_WRITABLE_SOCKET"
    return "PRESENT_POLICY_NOT_ATTESTED_RPC_NOT_TESTED"


def main() -> int:
    if len(sys.argv) != 1:
        print("ARGUMENTS=REJECTED")
        return 2
    if socket.gethostname().split(".", 1)[0] != "google-vps1":
        print("HOST=WRONG_HOST")
        return 2
    print("GOOGLE_SUPERVISOR_RECOVERY_DOCTOR=READ_ONLY")
    print("EXISTING_AGENT_CONFIG=" + config_metadata())
    for index, unit in enumerate(UNIT_NAMES):
        print(f"UNIT_{index}_{unit.split('.', 1)[0].upper().replace('-', '_')}=" + status(unit))
    print("SUPERVISOR_SOCKET=" + socket_metadata())
    print("OLD_SOURCE_STAGE=" + stage(OLD_SOURCE))
    print("SIGNED_SOURCE_STAGE=" + stage(SIGNED_SOURCE))
    print("ROOT_STAGE_PRESENCE_IS_NOT_SIGNATURE_VERIFICATION=TRUE")
    print("BOOTSTRAP_OR_RESTART=NOT_EXECUTED")
    print("CONFIG_AND_CREDENTIAL_CONTENT=NOT_READ")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
