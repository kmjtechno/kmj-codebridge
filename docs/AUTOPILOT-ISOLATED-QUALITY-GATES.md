# KMJ CodeBridge — Isolated autonomous quality gates

**Status:** opt-in development capability; no live Google VPS or Lenovo P720 agent was updated as part of this change.

## Problem solved

Running a configured QA gate directly from a repository requires its working directory to be clean. CloudOS's Google VPS checkout and CodeBridge's P720 checkout contain valuable uncommitted work by parallel agents. A safe quality worker previously rejected **all** such automated gate tasks as `GIT_HEAD_CHANGED_OR_WORKTREE_DIRTY`, even when the exact committed SHA could be independently validated.

## New behavior

Set `autopilotGateWorker.isolatedWorktree` to **true** in the **authorized local CodeBridge agent configuration**, only for an administrator-reviewed writable project already using an allowlisted quality gate:

```json
{
  "autopilotGateWorker": {
    "enabled": true,
    "gates": ["fast"],
    "isolatedWorktree": true
  }
}
```

This is a **project stanza**, not a complete device config, and editing a production agent config requires the normal owner-approved rollout.

On a task `auto-gate:fast:<exact-current-HEAD-SHA>` with the caller's existing **write + execute** permissions and a valid execution entitlement:

1. Check that the specific administrator-configured gate is allowlisted, the task's SHA exactly matches current repository HEAD, runner capacity is available and the worker is explicitly enabled.
2. Reuse CodeBridge's existing, separately stored `WorktreeLanes` manager to prepare **one detached, clean worktree** at that exact SHA. At most four isolated worktrees exist per project. A dirty pre-existing worktree is **never force-cleaned**.
3. Verify detached checkout SHA and cleanliness, then launch the fixed administrator-configured gate within that worktree, with the same job budget, timeout, concurrency, audit and lease protections.
4. Keep the original working tree, Claude changes, untracked files and all unrelated worktrees untouched. Do not auto-delete the isolated lane after the gate; artifacts or failures may need manual review.
5. A failed/non-zero gate remains a WAITING review item and cannot be advertised as PASS. New dependencies or an absent runner fail closed.

Default `isolatedWorktree:false` keeps previous behavior, refusing dirty checkouts. No new general-purpose shell, new tool grant, CI runner, network API, paid AI, model, product deployment, DNS change or production merge was introduced.

## Limits and next real acceptance

- Existing gate commands may assume dependencies available in the _original_ checkout. A newly detached worktree does **not** inherit its node_modules, Python venv, .env or generated artifacts. Add a **scoped trusted staging install and pinned dependency cache** only after independent review. Never silently symlink production secrets or credential stores into a lane.
- `git worktree add` is a filesystem mutation and repository Git metadata operation, restricted to explicit opt-in on an authorized development project. Repo-controlled checkout filters or Git config may execute as part of checkout; review source/repository trust first.
- Source branch/CI proof is not equivalent to the running agent having this revision. Verify the built runtime, active agent revision, offered MCP permissions and actual P720/Google VPS gate jobs after approved install.
- Before enabling unattended QA, check disk headroom. As of earlier Google VPS readings, approx. 12 GiB of free space remained, so avoid creating multiple heavy build worktrees or downloading full dependency trees.
- To test the feature: `node --test tests/autopilot-gate-worker.test.js`, `npm run check`, `npm test`, client/permission tests, then exact-head green CI on Windows and Linux. Finally run a harmless approved `fast` gate from the isolated lane while deliberately leaving the source checkout dirty, and verify the original file bytes remain unchanged.

**Performance objective (unmeasured):** remove manual cleaning/reconciliation of repositories from the approved QA critical path. This optimizes developer throughput and safety, **not** local model tokens/sec or customer HTTP throughput.
