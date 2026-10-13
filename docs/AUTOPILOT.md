# 24×7 Autopilot Architecture

KMJ CodeBridge 24×7 mode is designed as a persistent, event-driven orchestration layer, not as a busy polling loop and not as unrestricted remote shell access.

## Locked operating goals

- **Idle:** almost zero CPU, no repository scanning, no continuous hashing, no log polling and no repeated disk writes.
- **Active:** claim the highest-priority dependency-ready task and execute through existing bounded CodeBridge tools and configured quality gates.
- **Blocked:** move only the blocked task to `waiting`; independent queued work remains claimable.
- **Restart/reboot:** any task that was `running` is safely returned to `queued` with its last checkpoint preserved.
- **Disconnected chat or worker:** a claim is a time-bounded lease; when it expires, the next claim returns the task to `queued` so another chat can continue it.
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

## Claim leases (multiple chats and workers)

`autopilot_claim` accepts an optional `holder` label and returns the task with a `leaseToken` and `lease: {holder, expiresAt}` (default 30 minutes, bounded 1 minute to 24 hours).

- `autopilot_checkpoint`, `autopilot_wait` and `autopilot_complete` (and `autopilot_local_draft`'s checkpoint) **require** the matching `leaseToken` once a task has been claimed under lease-aware code. A missing or mismatched token is rejected with `AUTOPILOT_LEASE_LOST` — a missing token is exactly as unsafe as a stale one, since it would let any caller act on another holder's claimed work. Each checkpoint renews the lease, so active long work is not reclaimed.
- When a lease expires (the holder disconnected or stopped checkpointing), the next `autopilot_claim` for that project returns the task to `queued` with `lastReason: lease_expired`, then claims normally. `maxAttempts` still applies and exhausted tasks fail their dependents. The old holder's token stops working the instant the task is reclaimed.
- `autopilot_status` shows who holds a task and until when, never the token.
- Compatibility is preserved only for a genuinely legacy task: one still `running` from before this feature existed, which has no lease to fence. Any task claimed by lease-aware code — including after its lease expires and is reclaimed — is fenced from then on. A gateway or client that omits `leaseToken` can still claim new work and recover expired tasks, but cannot checkpoint, pause or complete anything it claimed, so upgrading both ends together is required for continued operation.

## Claim troubleshooting and mixed-version clients

A worker may omit `holder`, or supply a **1–96 character human-readable**
label containing letters, numbers, spaces, dots, underscores, colons, at signs,
hyphens, slashes or hashes (for example `Claude Code/P720 #1`). It is a
diagnostic label, not a credential or filesystem path.

A successful claim for a runnable task **must** return both `state: "running"`
and a fresh UUID `leaseToken`. If the result is `null`, no dependency-ready
task was claimable; this is not a successful lease. If a client reports an
internal error only with `holder` or gives a running task without a token,
**stop before checkpoint/wait/complete**. Check the agent's reported version
and deployed source SHA against the release, then test the same bounded holder
in a fresh authorized session. Never forge a token, omit fencing, mark the task
succeeded as a workaround, or expose returned lease tokens in logs/issues.

The claim dispatcher fails closed with `AUTOPILOT_CLAIM_CONTRACT_INVALID`
if an attached journal returns a running task without a valid fencing token
or with a mismatched holder. This is a source-level guard; an older installed
agent must be upgraded and verified separately before it can provide it.

Leases coordinate work; they do not add execution capacity. Concurrency remains bounded by the signed plan and device resources.

## Restart behavior

The journal has no background timer. On agent start, any task left in `running` is changed to `queued`, `recoveries` is incremented, `lastReason` becomes `agent_restart`, and the checkpoint remains intact. A future worker can therefore resume from the exact recorded next action instead of restarting the project from scratch.

## Current production state and remaining slices

The persistent queue/checkpoint layer has passed the full repository test/security/client gates and is live in the current agent. The restricted Linux Supervisor foundation is implemented and installer-integrated, and the signed-manifest/immutable-release verification and activation primitives are implemented. The low-load poll path has also been measured on the VPS after P3/P4/P5.

What remains before CodeBridge can truthfully claim unattended 24×7 AI execution is narrower and explicit:

1. connect an approved AI worker/scheduler that claims, checkpoints, waits/resumes and completes Autopilot tasks under bounded time/action/cost policy;
2. finish the signed-download/extraction + Supervisor health-check + automatic rollback orchestration before claiming unattended self-update;
3. run longer reconnect/soak and failure-injection evidence on supported production environments;
4. keep human/owner approval for production-destructive, billing, external-publication and other policy-gated actions.

The queue itself never implies background model reasoning. Without an explicitly configured worker/provider, CodeBridge persists and coordinates tasks but does not manufacture autonomous AI execution.
