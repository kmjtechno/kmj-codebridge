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
executing under its S4U logon has network or encrypted-file access. Windows
Task Scheduler explicitly states S4U logons cannot access the network or
encrypted files. The disabled task is structurally valid but unsuitable for
this outbound gateway agent. https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype

In particular: do not run the _different_
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
- exact _disabled_ Scheduled Task action, owner SID equivalence, S4U limited
  logon and boot/recovery policy;
- running Windows supervisor task, no active jobs or autopilot journal items.

Results are deliberately fail-closed: exit **2** for failed local prerequisite,
exit **3** when all local metadata checks pass but the S4U logon is a **known
network-incompatible identity** (`TAKEOVER_S4U_NETWORK_INCOMPATIBLE`).
Do not attempt a network canary under S4U; no canary can remove the underlying
Task Scheduler network/credential limitation. A future approved non-S4U
identity, fresh gateway heartbeat, and rollback proof are still missing. The
script **never returns ready=yes**, never changes a scheduled task, and never
interrupts the active CodeBridge/CineCore agent.

The `-SelfTest` flag only checks the SID resolver on a Windows test runner.
It never inspects, repairs, activates or registers local tasks.

## Remaining engineering gates before _any_ controlled -Apply

1. Replace the **deployment design**, not the current task in place: choose an
   operator-approved non-S4U identity. `InteractiveToken` can use an existing
   logged-on user session (not unattended across logoff/reboot). A password
   logon or dedicated service identity requires explicit credential/security
   review; do not enter passwords or secrets into chat or repo. Verify that
   identity's access to enrollment and outbound gateway before promotion.
2. Implement an exact-process-owner takeover transaction that fences active
   work, snapshots known-good task/process settings and local state, and
   explicitly prevents simultaneous sessions of the same enrolled device.
3. Verify a new managed agent process and newly observed gateway heartbeat
   within a deadline (not merely local process creation or stale connection
   files), before advertising restart support.
4. On failure, restore the disabled-task state and original agent under the
   original identity, verify heartbeat, and report any rollback failure.
5. Test genuine Windows scheduled-task lifecycle, non-S4U identity and
   credential permissions, duplicate registration refusal, old-agent exit,
   new-agent heartbeat and negative rollback cases on the physical P720.

**No blind task enable/start, no stop-process from ChatGPT, no rewriting
`agent.json`, no editing the dirty project worktree, and no upgrade through
an unsigned/unverified release.** Do not mistake successful hosted Windows CI
for physical workstation acceptance.

Related: [CodeBridge #393](https://github.com/kmjtechno/kmj-codebridge/issues/393)
and prior read-only principal SID repair PR #526.
