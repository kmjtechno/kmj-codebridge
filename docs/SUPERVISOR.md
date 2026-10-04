# Restricted CodeBridge Supervisor

The CodeBridge Supervisor is the local privileged maintenance boundary for 24×7 recovery. It is deliberately smaller than a shell and does not accept arbitrary commands, service names, paths, environment variables or executables.

## Security boundary

The only recognized services are:

- `agent` → `kmj-codebridge-agent.service`
- `gateway` → `kmj-codebridge-gateway.service`

The only recognized configuration files are the fixed CodeBridge paths under `/etc/kmj-codebridge`. Callers cannot supply a filesystem path.

Initial operations:

- `status` — bounded systemd state for one allowlisted CodeBridge service
- `logs` — at most 200 journal lines, passed through CodeBridge redaction
- `config_validate` — schema validation only; config contents and credentials are never returned
- `restart` — schedules restart of one allowlisted CodeBridge service after the acknowledgement is sent
- `disk_space` — fixed CodeBridge state filesystem, with no caller-selected path

The agent exposes these through MCP as read operations except restart, which requires the existing `execute` permission.

## IPC

Linux uses a Unix-domain socket. The production client accepts exactly:

`/run/kmj-codebridge/supervisor.sock`

A caller cannot redirect the agent to another local socket. The server protocol is one bounded JSON request and one bounded JSON response per connection. There is no shell command field.

The server supports systemd socket activation through inherited file descriptor 3. When socket-activated it can exit after an idle window; systemd keeps the listening socket and starts it again on demand, so the Supervisor consumes no long-running CPU while unused.

## One-click installer integration

The VPS installer now provisions the Supervisor as a systemd socket-activated service:

- `kmj-codebridge-supervisor.socket` owns the fixed Unix socket.
- The socket file is `0600` and owned by the CodeBridge agent service user/group.
- The parent socket directory is created with traversal-only permissions for non-owners.
- `kmj-codebridge-supervisor.service` runs as root only when the socket is used and exits after the Supervisor idle window.
- The Supervisor service is hardened with `NoNewPrivileges`, strict filesystem protection, kernel/control-group protection, `RestrictSUIDSGID`, `LockPersonality` and `AF_UNIX`-only address families.
- Existing agent configuration is migrated only to the one canonical Supervisor socket path. Any unexpected pre-existing Supervisor path causes the installer to fail closed.
- Agent and Supervisor unit files are backed up and restored together if installation or live verification fails.
- Installation completes only after the agent reconnects to the gateway and a local Supervisor status request confirms the agent service is active.

## Current boundary and remaining slices

The Supervisor foundation is implemented and installer-integrated. Signed release verification, immutable staging/activation and local rollback primitives are also implemented separately in the update/release-store modules.

Software update and rollback are **not yet exposed as Supervisor RPCs** because the privileged boundary must stay fail-closed rather than becoming a generic command path. Signed archive download/extraction and a dependency-injected health-checked activation/rollback orchestration core are now implemented and tested. Before update operations are enabled on production devices, CodeBridge still needs:

1. live production evidence for status/log/config/restart on the supported installer path;
2. configured signed-manifest/signature retrieval and release-signing key custody;
3. a concrete preflight implementation for the supported runtime environment;
4. allowlisted `update_check`, `update`, `rollback` and `release_history` RPCs wired only to the fixed updater/ReleaseStore/orchestrator primitives;
5. fixed Supervisor restart plus authenticated agent/gateway health probes on the live immutable runtime layout, including a fault-injection rollback drill.

Until that sequence is merged and live-tested, installer rerun is the supported repair/update path and the Supervisor must not accept caller-selected commands, paths, URLs or service names.
