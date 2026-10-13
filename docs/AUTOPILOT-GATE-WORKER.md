# Opt-in unattended quality-gate worker

CodeBridge agents can now execute **explicitly queued, administrator-approved
quality gates** without a chat session. This is a bounded first step toward
unattended engineering, **not** arbitrary AI coding or automatic merge.

## Safety and cost

- Disabled by default. Disabled agents create no additional polling timer.
- Uses the existing Node process, Git binary, signed entitlement and the
  project administrator's existing gate command. No extra runtime dependency,
  paid inference, cloud account or runner service.
- Only writable projects and explicit allowed gate IDs are eligible.
- Enqueueing an `auto-gate:` task requires **both write and execute** rights.
  A write-only client cannot schedule unattended execution.
- The task must use `auto-gate:GATE:COMMIT` with a full 40-character Git
  commit SHA matching the locally checked-out HEAD.
- No uncommitted changes, untracked files or changed HEAD are permitted
  before a task starts. The task moves to `waiting` instead of touching an
  in-progress Claude or human checkout.
- Generic README/mission tasks are never interpreted as executable commands.
  An AI model cannot supply shell, file paths, environment or arguments.
- A gate failure, unknown gate, resource problem or checkout mismatch does
  not silently become success; failed gates move to review-required waiting.
- Existing Autopilot lease fencing, restart recovery, job-runner idempotency,
  resource quotas, approved command profiles and durable job results remain
  the sources of truth.
- Long-running gates renew their task lease when necessary. Jobs are not
  automatically repeated if the worker restarts.

## Example owner-managed agent project config

Add the following property to an existing `projects[]` entry that already
declares a gate called `fast` and has `writable: true`:

```json
{
  "autopilotGateWorker": {
    "enabled": true,
    "gates": ["fast"]
  }
}
```

This **does not** set a default authorization for all gates. Enable only a
safe verification gate after validating the command and checkout. Never
enable network/deployment/destructive commands as unattended gate recipes.

The administrator or authorized client enqueues an Autopilot task with:

- project: the already-authorized project ID
- key: `auto-gate:fast:<exact-40-character-commit-SHA>`
- objective: human-readable description of the intended verification
- priority: bounded ordinary Autopilot task priority

The agent service executes only matching recipes. All other work, including
the original persisted roadmap DAG, remains queued for real coding agents or
manual approval. This avoids silently claiming a task that the worker cannot
actually complete.

## Known limits and rollout

1. Run this on **isolated, trusted CI workspaces** when possible. Clean Git
   status is a safety precondition, **not** a sandbox; an approved gate itself
   may write files, and races with another process remain possible.
2. A failed or dirty-checkout task needs an explicit human or authorized
   worker resume. There is no busy-loop retry or false completion.
3. This worker does not turn local draft inference into verified code edits.
   Full autonomous coding requires an approved model adapter, structured
   edit plans, tests, validated PRs, durable context and security boundaries.
4. First verify Node unit tests and Windows/Linux CI. Activate only after a
   clean checkout, enrolled scoped agent, configured gate and rollback path
   are available. Do not switch on for current dirty P720 CodeBridge or
   CineCore working trees.
5. For macOS release readiness, test the real signed installer and launchd
   integration independently; Node platform tests alone do not prove that.

No persistent 24/7 execution is claimed for a machine that is powered off,
disconnected or lacks an approved free worker. The agent service must be
started at boot by an administrator-managed service.
