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
