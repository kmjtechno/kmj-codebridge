#!/usr/bin/env python3
"""Offline-only, zero-mutation unit renderer for the dedicated Elite CodeBridge dev Supervisor.

The installed service must run unprivileged as kmjdev, not as root. This
renderer does NOT install packages, activate sockets, alter ACLs, enroll
devices, change credentials, or publish a release. An independent reviewed
Elite-only installer must verify a signed immutable root-owned source tree,
systemd effective properties, agent identity, socket ACL, rollback and an
authenticated post-install RPC before the feature can be called live.
"""
import argparse
import json
import re

SHA_PATTERN = re.compile(r"[a-f0-9]{40}\Z")
VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")
NODE_PATHS = frozenset((
    "/opt/kmj-codebridge-node/bin/node",
    "/usr/bin/node",
))
BASE = "/opt/kmj-codebridge-stable/releases"
SOCKET = "/run/kmj-codebridge-dev/supervisor.sock"
UNIT = "kmj-codebridge-dev-supervisor"
PRINCIPAL = "kmjdev"
PROFILE = "codebridge-dev-elite"


def render_units(sha: str, node: str, version: str) -> dict[str, str]:
    if not isinstance(sha, str) or SHA_PATTERN.fullmatch(sha) is None:
        raise ValueError("EXACT_IMMUTABLE_SOURCE_SHA_REQUIRED")
    if node not in NODE_PATHS:
        raise ValueError("ROOT_MANAGED_NODE_PATH_REQUIRED")
    if not isinstance(version, str) or VERSION_PATTERN.fullmatch(version) is None:
        raise ValueError("EXACT_RELEASE_VERSION_REQUIRED")
    source = f"{BASE}/{version}-{sha[:12]}"
    service = f"""[Unit]
Description=KMJ CodeBridge Elite dev read-only Supervisor
Requires={UNIT}.socket
After={UNIT}.socket

[Service]
Type=simple
User={PRINCIPAL}
Group={PRINCIPAL}
WorkingDirectory={source}
ExecStart={node} {source}/src/cli.js supervisor
Environment=KMJ_CODEBRIDGE_SUPERVISOR_PROFILE={PROFILE}
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
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
"""
    socket = f"""[Unit]
Description=KMJ CodeBridge Elite dev private read-only Supervisor socket

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
    parser.add_argument("--version", required=True)
    parser.add_argument("--node", default="/opt/kmj-codebridge-node/bin/node")
    args = parser.parse_args()
    try:
        units = render_units(args.source_sha, args.node, args.version)
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps({
        "mode": "OFFLINE_RENDER_ONLY",
        "installed": False,
        "operator_approved": False,
        "source_signed_and_verified": False,
        "runtime_identity_verified": False,
        "socket_acl_verified": False,
        "production_release_gate_credit": False,
        "units": units,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
