# P720 one-click supervisor preparation

Status: **source preparation only**. A disabled Windows startup task is not a
running supervisor, and a new release checkout does not upgrade a running agent.

## Trusted release / isolation

This path uses SHA e3587be842dcc701236b54a2e1de90238a5c3429
(the exact green merged PR #462 revision) from the fixed public origin
https://github.com/kmjtechno/kmj-codebridge.git. The bootstrap creates a
NEW directory under D:\KMJ-HyperSpeed\codebridge-releases. It does not run
git fetch/checkout/reset in the live D:\KMJ-HyperSpeed\projects checkout.
It runs npm ci with lifecycle scripts disabled and no dev packages.

## One local action for preparation

1. From a **trusted checkout of this bootstrap change**, keep the scripts
   in scripts/windows together. If downloading a GitHub ZIP, unblock the ZIP
   in Windows Properties before extracting if it has a Mark-of-the-Web;
   do not disable the machine's execution policy.
2. On the P720, right-click
   scripts/windows/PREPARE-P720-SUPERVISOR.cmd and select
   **Run as administrator**. This performs the preparation -Apply.
3. The bootstrap validates the existing agent file locally, stages the
   pinned runtime, and calls install-windows-supervisor.ps1. A new token
   receives a restricted ACL, backups contain SHA-256 hashes, and a
   scheduled task with startup trigger and bounded restart policy is
   registered **DISABLED**. The installer prints its exact backup directory.
4. Review agent.json.proposed and the backup manifest using local operator
   controls before any activation. Never copy credentials or the agent
   config into a chat. The existing agent and independent CineCore task
   are not stopped or changed.

The PowerShell entrypoint also supports a no-write dry run (omit -Apply), but
the CMD launcher intentionally runs the one-time preparation. If any
precondition is unmet, the script fails closed and leaves incomplete
artifacts for inspection; it never force-cleans or overwrites them.

## Activation and recovery are separate

The startup trigger and bounded restart settings do **not** enable the
prepared task. Actual activation requires verifying the manifest, confirming
the service account and ACL, enabling/starting the specific supervisor task,
an authenticated named-pipe status request, then a safe update/restart of the
existing agent. Do not claim CodeBridge has Windows supervisor commands
before supervisor_status returns a real windows-native result.

The current bootstrap deliberately omits supervisor agent.restartTask and
projects[]: it cannot guess an existing agent task name or safe CineCore Qt,
CMake and Git executable paths. Add those only after an operator verifies
fixed task identities and tool paths. Approved project gates remain available
without an unrestricted PowerShell interface.

For rollbacks use the exact backup folder printed by the installer and the
existing scripts/windows/rollback-windows-supervisor.ps1 dry-run first.
The rollback refuses changed tokens, configs and unknown task actions.

## Second one-click operation: guarded supervisor activation

After preparation, run `scripts/windows/ACTIVATE-P720-SUPERVISOR.cmd`
using **Run as administrator** from the verified matching source tree.
This launcher selects exactly one prepared supervisor backup under the fixed
backup root. Multiple candidates cause a hard refusal, not a guess.

Activation compares the immutable runtime SHA, trusted origin, exact task
executable/arguments/working directory, backed-up config SHA-256, proposed
agent configuration and token hash. It enables and starts **only** the fixed
disabled supervisor task, then requires an actual HMAC-authenticated
`status(agent)` over the Windows named pipe. A failed start or handshake
causes a stop/disable attempt; the operator must still inspect Windows
Task Scheduler after a failure.

**The agent is not updated or restarted by this launcher.** This deliberate
separation prevents accidentally replacing the connected agent with an
unknown task identity. After successful native supervisor status, independently
verify the active agent task command, the pinned release, enrollment identity,
rollback, and compatibility before applying `agent.json.proposed` and
restarting that exact agent task. A running supervisor alone does not
prove automatic task continuation, command-profile activation or CineCore
build support.

Rollback with `-RestoreConfigs` now refuses to overwrite any original
configuration that changed after backup.

## One-click KMJ native supervisor setup (no third-party runtime)

For a **fresh**, never-before-prepared P720 supervisor, the simplest path is
`scripts/windows/ONE-CLICK-P720-SUPERVISOR.cmd`, run once as administrator
from a reviewed, trusted checkout. It chains the existing exact-SHA isolated
preparation and HMAC-guarded activation, aborting immediately if either
fails. Existing tokens, a previous preparation, multiple manifests or
unexpected scheduled tasks are **not** overwritten or guessed: the scripts
refuse and require inspection instead of a destructive retry.

This starts the KMJ-authored native named-pipe supervisor, not an external
Supervisor/Cygwin service. It **does not** change `agent.json`, restart or
upgrade the currently connected CodeBridge agent, touch CineCore, or enable
autonomous command profiles. Agent wiring remains a separate reviewed step
so that the old production agent enrollment is not destroyed. After a
successful authenticated supervisor status, verify the agent handoff
independently; no feature is considered live merely from CI or a task start.

## Recover an interrupted Windows installation without re-running the old CMD

If the original console printed `Cloning into ...`, `Receiving objects:
100%`, `Resolving deltas: 100%` but did not reach `KMJ_NATIVE_SUPERVISOR_HMAC=PASS`,
**do not start another installer from the same incomplete tree**.

Use a trusted copy of the current main branch (including the BOM-free
manifest fix, PR #472). From `scripts/windows`, right-click
`RECOVER-P720-SUPERVISOR.cmd` and choose **Run as administrator**.

The recovery script checks locally without revealing keys:
- Whether the original Git/npm process is still active (if yes it does
  not start a second installer).
- Whether the isolated SHA-pinned release exists and is immutable.
- Whether the Git clone completed but the separate SHA checkout did not:
  it may finish the detached checkout **only** if the directory contains
  exactly `.git`, the Git index has no files, and the expected commit is
  already locally present.
- Whether one complete, disabled and backed-up supervisor task can be safely
  activated with the existing HMAC verifier.
- If a supervisor task is already enabled, it only tries authenticated
  HMAC status; it does not reinstall or restart anything.

Any suspicious configuration, unexpected task, token, partial registration,
more than one backup manifest, changed checkout or active installer causes
**RECOVERY_BLOCKED** without deleting anything. The script never overwrites
the current CodeBridge enrollment or CineCore agent.

To inspect without any mutation, run
`RECOVER-P720-SUPERVISOR.ps1` without `-Apply`.
The final verified success marker is
`KMJ_RECOVERY_SUPERVISOR=VERIFIED`. That proves only local native
supervisor authentication, **not** a connected ChatGPT/Claude tool or
autonomous worker. The existing agent still needs a separately verified,
non-destructive supervisorPipe/token handoff.
