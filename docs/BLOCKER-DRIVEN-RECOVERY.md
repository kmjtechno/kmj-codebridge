# KMJ CodeBridge — Blocker-driven recovery (P0)

**Owner rule:** when an issue blocks an AI engineering task, fix the reusable missing capability in KMJ CodeBridge, keep other independent work moving, and never bypass security, CI or consent.

## Native existing-tool integration

1. **`connection_doctor`** still works with its old `{device, project}` call and now includes a `blockerRecovery` read-only report.
   - Optional `clientVisibleTools` distinguishes a client app that has not advertised the already-implemented `local_model_status`, `local_model_generate` and `autopilot_local_draft` from a failed device inference service. Omit the field rather than inventing a tool list.
   - Optional `ciObservation` separates `job-no-steps` (provider runner/account problem) from `executed-test-fail` (real code/tests), as well as pending, passed and unknown. **Client-supplied, not independently verified**.
   - Optional `checkoutState` warns on a reported dirty checkout without resetting Claude or another agent's work.
   - Worker runtime reports `loopStarted=true/false/null`; **null is not silently interpreted as stopped**. A local-draft loop is not a fully autonomous coder. No production action occurs.

2. **`autopilot_wait`** now accepts optional `blockerCode` from a fixed source-owned catalog. When an authorized lease holder explicitly pauses its running task, CodeBridge atomically persists the wait, then queues an **independent, idempotent recovery-feature task** named `blocker:<code>:<source-task-uuid>`. It does **not** start source editing, AI inference, paid API calls, extra processes or deployment. Repeated identical enqueues reuse the same journal entry; if the journal is full or conflicted, the original wait remains and an explicit `RECOVERY_QUEUE_UNAVAILABLE` is reported.
   - No `blockerCode` keeps the old `autopilot_wait` behavior unchanged.
   - The original lease still must be valid; no stale caller can enqueue by forging a reason.
   - Independent work stays claimable. A separate authorized worker must actually claim/execute/checkpoint the recovery task.

### Example

`connection_doctor({device:"google-vps",project:"kmj-cloudos",clientVisibleTools:["connection_doctor","autopilot_status"],ciObservation:"job-no-steps",checkoutState:"dirty"})`

Then an authorized **real current lease holder**, if blocked, may call:

`autopilot_wait({device:"google-vps",project:"kmj-cloudos",task:"<actual task UUID>",leaseToken:"<actual confidential lease>",reason:"CI job did not record any steps",blockerCode:"CI_NO_RUNNER_STEPS"})`

Never commit or share the lease token. Every recovery is a proposal for reviewed **CodeBridge** capabilities, not an exception to production rules.

## First supported blockers

- `CLIENT_TOOL_NOT_ADVERTISED`: compare installed client capture with authenticated hosted MCP `tools/list` and installed agent revision; update/reconnect via supported workflow.
- `WORKER_CONFIGURED_NOT_STARTED` / `WORKER_STATUS_NOT_INSTRUMENTED`: verify supervisor, actual handles and agent update state.
- `NO_AUTONOMOUS_CODING_EXECUTOR`: build a real consented/lease-bound local-first and isolated coding executor, rather than relying on heartbeat-only 60-second timers.
- `CI_NO_RUNNER_STEPS` / `CI_TEST_FAILURE`: distinguish provider CI bootstrap from real exact-SHA test failures.
- `CHECKOUT_DIRTY`: preserve parallel agents' changes and use only clean pinned worktree/lane.

## Boundaries and release

Pure planning + journal queuing only; permission required, no arbitrary subprocess/service control or unbounded retries. Source-based diagnosis does not prove a live AI worker exists. Existing CodeBridge gateway/client schema, installed release and real tenant permissions must be independently verified before saying it is deployed. The connected client may need an approved schema refresh to expose optional arguments. No provider automatically offers unlimited free model calls.

**QA:** `node --test tests/blocker-recovery.test.js`, then `npm test`, `npm run check`, secrets/client gates and exact-head PR CI. Keep PR draft until they pass. Never modify a live dirty P720 checkout merely to run these tests.
