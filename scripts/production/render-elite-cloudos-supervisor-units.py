#!/usr/bin/env python3
"""Offline-only, credential-free systemd unit renderer for the Elite CloudOS lane.

This tool NEVER installs units, starts services, changes credentials, or touches
the existing kmjcode Main Platform Supervisor. An independent privileged,
owner-approved operator must pin/verify the immutable runtime and authorize
any host change with a rollback and real service/IPC test.
"""
import argparse
import json
import re

SHA_PATTERN = re.compile(r"[a-f0-9]{40}\Z")
NODE_PATHS = frozenset((
    "/opt/kmj-codebridge-node/bin/node",
    "/usr/bin/node",
))
BASE = "/opt/kmj-codebridge-cloudos-supervisor"
SOCKET = "/run/kmj-codebridge-cloudos/supervisor.sock"
UNIT = "kmj-codebridge-cloudos-elite-supervisor"
PRINCIPAL = "kmjcloudosdev"


def render_units(sha: str, node: str) -> dict[str, str]:
    if not isinstance(sha, str) or SHA_PATTERN.fullmatch(sha) is None:
        raise ValueError("FULL_IMMUTABLE_GIT_SHA_REQUIRED")
    if node not in NODE_PATHS:
        raise ValueError("ROOT_OWNED_NODE_PATH_REQUIRED")
    source = f"{BASE}/{sha}"
    service = f"""[Unit]
Description=KMJ CloudOS Elite restricted read-only Supervisor
Requires={UNIT}.socket
After={UNIT}.socket

[Service]
Type=simple
User={PRINCIPAL}
Group={PRINCIPAL}
WorkingDirectory={source}
ExecStart={node} {source}/src/cli.js supervisor
Environment=KMJ_CODEBRIDGE_SUPERVISOR_PROFILE=cloudos-elite
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateNetwork=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
"""
    socket = f"""[Unit]
Description=KMJ CloudOS Elite restricted private Supervisor socket

[Socket]
ListenStream={SOCKET}
SocketUser={PRINCIPAL}
SocketGroup={PRINCIPAL}
SocketMode=0600
DirectoryMode=0711
RemoveOnStop=yes
Service={UNIT}.service

[Install]
WantedBy=sockets.target
"""
    return {f"{UNIT}.service": service, f"{UNIT}.socket": socket}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--node", default="/opt/kmj-codebridge-node/bin/node")
    args = parser.parse_args()
    try:
        units = render_units(args.source_sha, args.node)
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps({
        "mode": "OFFLINE_RENDER_ONLY",
        "installed": False,
        "approved": False,
        "runtime_verified": False,
        "release_gate_credit": False,
        "units": units,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
