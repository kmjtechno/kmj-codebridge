# P720 managed CodeBridge agent takeover — safe readiness gate

Status: **read-only prerequisite implemented; activation NOT implemented or approved**.

## Why a separate gate

The already-connected P720 CodeBridge agent runs from an exact pinned release
(`e3587be842dcc701236b54a2e1de90238a5c3429`). The Windows-native
supervisor is present but says `restart.supported=false` and
`update.supported=false`. The existing `KMJ-CodeBridge-P720-Agent`
Scheduled Task is **Disabled**. A SHA-pinned independent audit run by the
operator on 2026-10-18 verified `REUSABLE_DISABLED` and the same owner SID as
the live agent. This only proves the task's metadata; it does **not** prove that
executing under its S4U logon has equivalent local file/credential/network
permissions or that switching processes will preserve a gateway connection.

In particular: do not run the *different*
`HANDOFF-P720-AGENT-SUPERVISOR.ps1 -Apply`. That script is for migration from
a source-checkout agent to a pinned supervisor-wired agent, and explicitly
refuses an already pinned release agent. It is not a managed-task takeover.

## New read-only classification

Run `scripts/windows/VERIFY-P720-TASK-TAKEOVER-READONLY.ps1` from
**Administrator PowerShell**, with no arguments, from an independently
SHA-pinned source snapshot. Do **not** pass `-Apply`: it does not exist.

The script checks, without returning user names, tokens or raw command lines:

- trusted immutable CodeBridge release SHA and source origin, no git changes;
- scoped agent config and supervisor pipe/token locations;
- exact one visible matching agent process and its agent.lock PID;
- exact *disabled* Scheduled Task action, owner SID equivalence, S4U limited
  logon and boot/recovery policy;
- running Windows supervisor task, no active jobs or autopilot journal items.

Results are deliberately fail-closed: exit **2** for failed local prerequisite,
exit **3** if local checks pass but the S4U task-context network/credentials
canary, fresh gateway heartbeat, and rollback proof are still missing. The
script **never returns ready=yes**, never changes a scheduled task, and never
interrupts the active CodeBridge/CineCore agent.

The `-SelfTest` flag only checks the SID resolver on a Windows test runner.
It never inspects, repairs, activates or registers local tasks.

## Remaining engineering gates before *any* controlled -Apply

1. Establish S4U task-context access to the enrollment and token resources
   and outbound gateway **without launching another agent**. An ordinary
   interactive-user network probe does not satisfy this.
2. Implement an exact-process-owner takeover transaction that fences active
   work, snapshots known-good task/process settings and local state, and
   explicitly prevents simultaneous sessions of the same enrolled device.
3. Verify a new managed agent process and newly observed gateway heartbeat
   within a deadline (not merely local process creation or stale connection
   files), before advertising restart support.
4. On failure, restore the disabled-task state and original agent under the
   original identity, verify heartbeat, and report any rollback failure.
5. Test genuine Windows scheduled-task lifecycle, S4U permissions, duplicate
   registration refusal, old-agent exit, new-agent heartbeat and negative
   rollback cases on the physical P720.

**No blind task enable/start, no stop-process from ChatGPT, no rewriting
`agent.json`, no editing the dirty project worktree, and no upgrade through
an unsigned/unverified release.** Do not mistake successful hosted Windows CI
for physical workstation acceptance.

Related: [CodeBridge #393](https://github.com/kmjtechno/kmj-codebridge/issues/393)
and prior read-only principal SID repair PR #526.
