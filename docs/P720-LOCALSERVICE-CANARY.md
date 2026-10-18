# P720: no-password LocalService canary (not a deployment)

Microsoft documents that S4U scheduled tasks have no network access or access
to encrypted files. Existing P720 agent task is disabled with S4U principal.
Changing it while the current agent is online is unsafe.

A bounded alternative is the built-in Windows `LOCAL SERVICE` identity
(SID `S-1-5-19`) with a `ServiceAccount` Task Scheduler logon. It is not
equivalent to the interactive user's identity and may lack access to the
private CodeBridge enrollment configuration or supervisor token. Never
broaden ACLs or transfer enrollment tokens just to obtain a PASS.

This feature contains two scripts:

- `scripts/windows/CANARY-P720-LOCALSERVICE.ps1`: one-shot read-only
  canary that requires LocalService SID. It checks byte-free readability of
  the existing `agent.json`, `supervisor.token`, `state/agent.lock`,
  then performs a certificate-validated HEAD request to the public
  `https://kmjtechno.com/` origin. It never authenticates to the gateway,
  starts an agent, prints identities or returns token bytes. It writes only
  fixed, bounded, non-secret `started.txt` and `result.txt` receipts into
  the newly created, temporary canary evidence directory, not into any
  CodeBridge agent/config/lock/token path. Returns 0 only if those limited
  checks pass. No credential handling.
- `scripts/windows/RUN-P720-LOCALSERVICE-CANARY.ps1`: Administrator-only
  runner. Without parameters it checks that the pinned original agent is
  unique, its lock agrees, and the original Scheduled Task is disabled.
  With explicit `-Apply` it downloads the companion from an immutable
  commit and checks its exact Git blob, stages into a **new**, restricted
  ProgramData directory, registers a **temporary no-trigger** task under
  LocalService, runs the _canary only_, queries the exit code and removes
  its own task and staged files after verifying task identity and hashes.
  It waits for both fixed receipts and a non-running task, rather than
  guessing completion from a narrow Task Scheduler `LastRunTime` window.
  It separately prints scheduler state/last result and task/file cleanup
  outcomes; neither scheduler success nor process disappearance can replace
  a well-formed result receipt. If a task or folder with its reserved name
  already exists, it refuses instead of overwriting or deleting it.

The runner is **not** a managed agent task installer. Its transient task
never executes `node src/cli.js agent`, touches neither
`KMJ-CodeBridge-P720-Agent` nor `KMJ-CodeBridge-Supervisor`, does not
edit any credential/config/dirty checkout, and is never configured to run
at startup. Its cleanup leaves unrecognized or modified resources in place
and reports `MANUAL_REVIEW` rather than deleting foreign objects.

A canary code 0 with `PASS_LIMITED` receipt is **limited proof** of file-open
permission and public outbound HTTPS from LocalService. It does not prove the agent enrollment
credential works under that context, access to encrypted user data, HMAC
authorization, task restart or rollback, a successful CodeBridge gateway
session, or readiness for production cutover.

## Rollout restrictions

Do not execute `-Apply` until reviewed and SHA-pinned source CI is green.
Physical P720 operator approval is required to run the _new temporary
canary task_ under Administrator rights. That is a change to the host even
though it does not interrupt any existing agent. A connection to the P720
through CodeBridge does not grant authority for arbitrary Windows Task
Scheduler actions, so they must not be simulated or claimed to have run.

After physical canary PASS, separately design the managed service identity
with the least privileges needed for the gateway credential, a reversible
single-agent ownership transfer, fresh server-observed heartbeat, and
independently validated rollback. LocalService canary failure should block
rather than cause broad permissions changes.

Sources:

- https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype
- https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal

Related: #393; #526 (SID audit), #527 (read-only preflight),
#528 (S4U network incompatibility).

## P720 first-run evidence — 2026-10-18

The first owner-executed SHA-pinned canary runner returned
`CANARY_EXECUTION_TIMEOUT`, exit 2, while reporting
`CANARY_CLEANUP=OWN_CANARY_FILES_REMOVED` and no original agent/task mutation.
That outcome is **inconclusive**, not proof of LocalService permission or
network failure. Source review found that the runner required Task Scheduler's
`LastRunTime` to be within two seconds of the controller's start timestamp
and did not retain a separate canary completion receipt. This revision
supersedes the timing-only acceptance gate with bounded receipts and separate
cleanup markers. Hosted Windows AST/unit tests do **not** substitute for the
next physical Windows task run.

Do not rerun the original SHA `5378ae081df63238dede47273a756122cf6d8946`
with `-Apply`. Use only a subsequent reviewed and CI-green pinned revision.
