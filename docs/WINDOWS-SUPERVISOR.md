# Windows-native supervisor (P720)

Status: implemented and verified by GitHub-hosted Windows and Ubuntu CI at the PR #460 merge
(`96c6f31a0327e5079209cf0f4880d6d6d07dde10`). **Not activated on the P720**;
real workstation ACL, Scheduled Tasks, Qt/CMake and agent integration remain unverified. The Linux supervisor (`src/supervisor.js`, systemd socket) is
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

`-Apply` backs up configs (SHA-256 manifest), creates a new secret and restricts its ACL,
registers a **disabled** scheduled task, and writes `agent.json.proposed`. `agent.json` is not modified.
The installer refuses existing supervisor tasks, token files, proposed configs and already-configured
agents rather than overwriting them. Backups have collision-resistant names and record the task
identity and hashes of installer-owned token and proposed config. On interruption, preserve the
backup and invoke rollback; never manually delete an unfamiliar Windows task or token.

```powershell
.\scripts\windows\rollback-windows-supervisor.ps1 -BackupDir <backup folder>          # dry-run
.\scripts\windows\rollback-windows-supervisor.ps1 -BackupDir <backup folder> -Apply   # add -RestoreConfigs to restore agent/supervisor json
```

Rollback is also fail-closed: it refuses a different task name, a scheduled task whose executable or
arguments do not match the install manifest, or any token/proposed config changed after creation.
Existing user files are never deleted just because they have a familiar name.

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

## Read-only authorization for non-CMake projects

CodeBridge projects that do not use CMake (for example, the P720
`kmj-codebridge` Node.js checkout) should not be given a fabricated Qt/CMake
verification profile. The Windows supervisor can accept an independently
operator-configured `readOnlyProjects` list of at most four
`{ "id": "...", "repoRoot": "..." }` entries in addition to existing
CMake-enabled `projects`. Each ID must be unique across both lists.

A read-only entry authorizes only `project_status`: it reports whether
the fixed root exists and contains a Git checkout. It explicitly reports
`verification.supported=false`, no allowed stages and `allowFetch=false`.
It cannot authorize `project_verify_prepare`, `project_verify_stage`,
`project_verify_release`, remote fetch or a caller-selected command.
Unknown fields, unsafe paths and duplicate IDs are rejected.

This is a **source-level capability**, not a live P720 grant. The running
P720 native supervisor is still pinned to SHA
`e3587be842dcc701236b54a2e1de90238a5c3429`; it does not accept the
new setting. Do not edit its current JSON with the new key until a separately
verified, reversible runtime upgrade is installed. Likewise, Windows
restartTask remains unconfigured until the agent itself is managed by an
operator-reviewed scheduled task. An existing manually launched agent is
not a safe target for the supervisor's task-based restart operation.

## Safe preparation for persistent P720 CodeBridge agent

After the P720 native supervisor, HMAC, and read-only project checks are
live, the first prerequisite for task-based **agent restart** is an
operator-owned, trusted Windows Scheduled Task. The existing CodeBridge
agent currently runs as a separate process started during the P720 handoff.
It must **not** be duplicated by starting a second task.

Run `scripts/windows/PREPARE-P720-AGENT-TASK.ps1` without `-Apply`
for the default read-only preflight. It checks the live single agent,
running owner, Node binary, immutable release SHA, trusted Git origin,
agent ID and supervisor wiring, and refuses any existing task. The
separate administrator-approved `PREPARE-P720-AGENT-TASK.cmd` creates
exactly one **disabled** startup task
`KMJ-CodeBridge-P720-Agent` with pinned executable/arguments and
recovery settings; it never starts or stops the agent, supervisor,
CineCore or another project. It keeps the source checkout untouched.

The preparation does **not** enable remote restart. A disabled task
must report `restart.supported=false` when the supervisor later
encounters it. Safe activation requires a separate transaction that
confirms zero active jobs, preserves old process and task state,
switches to the scheduled task, verifies a fresh gateway heartbeat
without a duplicate device session, updates the supervisor config only
after proven takeover, and restores the original process/config/task
state if any stage fails. **Do not manually enable/start the new task
while the original agent remains online.**

The setup uses the original live agent's Windows identity as the
Scheduled Task principal; logon/network and service-account permissions
must be proven on the target workstation before activation. No Windows
auto-update mechanism is enabled by this preparation.

## Existing P720 agent task: do not rerun preparation

If `PREPARE-P720-AGENT-TASK.cmd` reports
`KMJ_AGENT_TASK_BLOCKER=AGENT_TASK_ALREADY_EXISTS`, treat this as a
**non-destructive collision**, not permission to replace or start the task.
The original preparation tool refuses the collision before modifying
anything. The task might already have been prepared, might be running,
or might be unrelated. Task existence alone proves none of those cases.

Use `AUDIT-P720-EXISTING-AGENT-TASK.cmd` as administrator to perform a
**read-only, secret-free audit** of the exact task name, pinned SHA,
original release checkout, config scope, process count, Windows task
action, principal, startup trigger, and restart policy. It does not
print the token, Windows account names or process command-line args.
It neither edits the registry/files nor starts/stops/changes tasks.

The only `KMJ_AGENT_TASK_AUDIT=REUSABLE_DISABLED` outcome requires
all identity/policy checks to match **and** the task to be Disabled.
`CONFLICT_NO_CHANGES` means that some attributes differ; preserve
the existing task and do not run a replacement task or old installer.
`ALREADY_ENABLED_OR_RUNNING_REVIEW_REQUIRED` means even an otherwise
matching task is not safe to treat as dormant. All non-matching cases
are fail-closed.

A reusable Disabled task still requires a separately authorized,
idle-gated transaction to hand off the connected original agent,
prove the new task's actual gateway heartbeat and health, and back out
without duplicate sessions if takeover fails. This audit does not
activate the task or enable `restart.supported`, and it does not
install Windows auto-update.
