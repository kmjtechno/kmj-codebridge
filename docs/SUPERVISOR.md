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

## Remaining slices

This foundation intentionally does not yet implement update or rollback. Those operations require the signed immutable-release design and must not be added as generic command execution.

Next steps:

1. install and harden the Supervisor systemd socket/service from the one-click installer;
2. validate live status/log/config/restart behavior on the VPS;
3. add signed release verification and immutable staging;
4. expose allowlisted `update_check`, `update`, `rollback` and `release_history`;
5. use these operations for autonomous recovery without Desktop Commander.
