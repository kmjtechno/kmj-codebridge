# Windows-native supervisor (P720)

Status: implemented and unit-tested on Linux CI hosts. **Not activated** and **not yet proven on a real
Windows host** (see "Evidence" below). The Linux supervisor (`src/supervisor.js`, systemd socket) is
unchanged and still refuses `win32`; Windows requests are never routed to systemd operations.

## What it is

`node src/cli.js windows-supervisor <supervisor.json>` listens on a fixed-prefix named pipe
(`\\.\pipe\kmj-codebridge-supervisor-<name>`). It answers a small allowlist of bounded operations and
refuses everything else with `SUPERVISOR_OPERATION_NOT_ALLOWED`.

| Operation                                            | Behaviour                                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device_status`, `disk_space`, `project_status`      | read-only facts                                                                                                                                                                        |
| `status` / `config_validate` (`service: agent` only) | truthful agent state, **runtime commit and its source**, `restart.supported`, `update.supported` (always `false`: no Windows updater exists yet)                                       |
| `restart` (`service: agent`)                         | only when `agent.restartTask` is configured **and** the scheduled task exists; fixed `schtasks /End` then `/Run`, executed after the reply is sent                                     |
| `project_verify_prepare`                             | pins an exact 40-hex SHA into a **separate detached worktree** under `worktreeRoot`; reports whether the original checkout's `git status` digest is unchanged                          |
| `project_verify_stage`                               | `configure`, `build` or `ctest` for that SHA; one run at a time (`SUPERVISOR_BUSY`); hard timeout with process-tree kill; capped, redacted log; receipt with exit code and log SHA-256 |
| `project_verify_release`                             | `git worktree remove` without `--force` (unsaved work is refused, not destroyed)                                                                                                       |

Callers choose only `projectId`, `sha` and `stage`. Executables, argv, cwd, environment, paths, task
names and the pipe name come from the operator's config file. Unknown request keys are rejected.

## Authentication and ACLs

Node cannot set a named-pipe DACL, so the pipe itself is **not** the security boundary. Every connection
gets a random nonce and must answer with `HMAC-SHA256(secret, nonce + "\n" + request)`; a MAC from one
connection is useless on another (replay), and a tampered request fails. The secret lives in
`tokenFile`; at start-up `icacls` output is inspected and the supervisor refuses to run if
Everyone/Users/Authenticated Users/ANONYMOUS LOGON/INTERACTIVE/NETWORK appear on it. The installer sets
the ACL to SYSTEM, Administrators and one service account (read).

## Agent wiring

`agent.json` gains two optional fields that must be set together, and never together with
`supervisorSocket`:

```json
{
  "supervisorPipe": "\\\\.\\pipe\\kmj-codebridge-supervisor-p720",
  "supervisorTokenFile": "D:\\KMJ-HyperSpeed\\private\\p720-codebridge\\supervisor.token"
}
```

## Install, backup, rollback (nothing starts)

```powershell
# dry-run first (default)
.\scripts\windows\install-windows-supervisor.ps1 -SupervisorConfig D:\...\supervisor.json -AgentConfig D:\KMJ-HyperSpeed\private\p720-codebridge\agent.json `
  -RuntimeDir D:\...\codebridge-releases\<sha> -BackupRoot D:\KMJ-HyperSpeed\private\backups -ServiceAccount <agent-user>
# then add -Apply
```

`-Apply` backs up configs (SHA-256 manifest), creates the secret if missing and restricts its ACL,
registers a **disabled** scheduled task, and writes `agent.json.proposed`. `agent.json` is not modified.

```powershell
.\scripts\windows\rollback-windows-supervisor.ps1 -BackupDir <backup folder>          # dry-run
.\scripts\windows\rollback-windows-supervisor.ps1 -BackupDir <backup folder> -Apply   # add -RestoreConfigs to restore agent/supervisor json
```

## Activation (manual, after review)

1. Review the dry-run output and the PR; run the Windows checks below on the P720.
2. Run the installer with `-Apply`; inspect `agent.json.proposed`.
3. Replace `agent.json` with the proposed file (keep the backup), enable and start the supervisor task,
   then restart the agent. Verify `supervisor_status` reports `supervisor: windows-native`.
4. If anything is wrong, run the rollback script.

## Evidence

Unit tests (`tests/windows-supervisor*.test.js`) cover config validation, truthful status, refusal of
Linux-only operations, fixed argv, worktree isolation, bounded execution (timeout/cap/redaction), the
HMAC protocol over a plain socket, ACL parsing against sample `icacls` output, and static checks of the
PowerShell scripts. They do not exercise a real Windows named pipe, `icacls`, `schtasks`, CMake/Qt or
PowerShell. Those require a Windows run on the P720 and are listed as pending in the PR.
