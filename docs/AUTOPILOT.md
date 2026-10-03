# 24×7 Autopilot Architecture

KMJ CodeBridge 24×7 mode is designed as a persistent, event-driven orchestration layer, not as a busy polling loop and not as unrestricted remote shell access.

## Locked operating goals

- **Idle:** almost zero CPU, no repository scanning, no continuous hashing, no log polling and no repeated disk writes.
- **Active:** claim the highest-priority dependency-ready task and execute through existing bounded CodeBridge tools and configured quality gates.
- **Blocked:** move only the blocked task to `waiting`; independent queued work remains claimable.
- **Restart/reboot:** any task that was `running` is safely returned to `queued` with its last checkpoint preserved.
- **Recovery:** task state is stored outside authorized project roots under the agent `stateDir`.
- **Security:** no arbitrary shell, arbitrary service name, arbitrary path, environment dump or secret-return API is introduced.

## Persistent state

`AutopilotJournal` stores one bounded JSON journal using atomic temp-file + fsync + rename persistence. Task text is passed through the same CodeBridge redaction layer used for job output before it is written to disk.

Each task records:

- project
- idempotency key
- objective
- priority
- dependencies
- state
- attempts and restart recoveries
- latest checkpoint summary and next action
- waiting reason
- bounded terminal result
- timestamps

Task states are `queued`, `running`, `waiting`, `succeeded`, `failed` and `cancelled`.

## MCP operations

The agent exposes project-scoped operations:

- `autopilot_status`
- `autopilot_enqueue`
- `autopilot_claim`
- `autopilot_checkpoint`
- `autopilot_wait`
- `autopilot_resume`
- `autopilot_complete`

These operations coordinate work only. They do not execute arbitrary commands. Actual code execution remains limited to existing CodeBridge file tools and administrator-configured quality gates.

## Dependency behavior

A queued task is claimable only when every declared dependency has succeeded. Waiting work never blocks unrelated ready work. Selection is deterministic: higher priority first, then creation time, then task id.

## Restart behavior

The journal has no background timer. On agent start, any task left in `running` is changed to `queued`, `recoveries` is incremented, `lastReason` becomes `agent_restart`, and the checkpoint remains intact. A future worker can therefore resume from the exact recorded next action instead of restarting the project from scratch.

## Next production slices

The persistent queue is the foundation, not the complete autonomous worker. Remaining dependency-ready work is:

1. validate this slice with the full CodeBridge test/security/client suite;
2. restart the agent so the new tools become live;
3. add the restricted Supervisor for allowlisted service status/restart/config/log/update/rollback operations;
4. add signed immutable self-update with automatic rollback;
5. connect an approved AI worker/scheduler to claim and checkpoint tasks continuously without weakening the CodeBridge security boundary;
6. measure idle CPU, disk writes and network reconnect rate before enabling default 24×7 mode.

No component should claim true unattended AI execution merely because the persistent queue exists. The worker/provider still has to be explicitly configured and verified.
