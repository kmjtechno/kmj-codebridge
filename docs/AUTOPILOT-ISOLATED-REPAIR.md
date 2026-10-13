# KMJ CodeBridge — 24×7 isolated repair candidate worker (opt-in)

This is the first **real mutating, bounded, unattended** repair component.
It is NOT a general autonomous AI fixer, automatic PR publisher, or production
deployer. Enabled only on approved writable agent projects. It creates an
isolated detached Git worktree, runs exactly one owner-approved fixing gate,
checks its entire resulting patch against an allowlist, runs a separate approved
verification gate, and **pauses for human/review-agent inspection** with durable
patch evidence. No paid models or runtime packages are added.

## Configuration (existing protected agent JSON)

Add to the chosen `projects[]` entry:

```json
{
  "autopilotRepairWorker": {
    "enabled": true,
    "recipes": {
      "format": {
        "fixGate": "format_src",
        "verifyGate": "fast_check",
        "triggerGate": "fast_check",
        "paths": ["src/", "tests/"]
      }
    }
  }
}
```

Both `format_src` and `fast_check` MUST already exist as administrator-owned,
non-destructive recipes under `project.gates`. `fixGate` and
`verifyGate` MUST differ. An allowed path is a literal relative tracked file
or directory prefix ending in `/`, not an arbitrary glob, absolute path or
shell command. For safety, use a targeted formatter only, never `npm install`,
`git reset`, a deployment command or an unbounded script as the fix gate.

## Queue an approved repair

Via the existing authorized `autopilot_enqueue` MCP action, requiring both
write AND execute permissions:

- project: existing enrolled writable project
- key: `auto-repair:format:<current-full-40-character-local-HEAD-SHA>`
- objective: brief description of the known formatting issue
- priority: within the existing journal range

A failed opt-in `auto-gate:fast_check:<full-SHA>` task may also queue this
recipe automatically when `triggerGate` equals the failed gate, without
requiring a second human enqueue. This never activates an unconfigured recipe.

The existing background agent worker (when installed and running) will
perform: check entitlement and resource pressure; lease exact eligible task;
prepare a uniquely named clean detached worktree; checkpoint a **no-replay**
fence; run the approved fixing gate; verify tracked, allowlisted, regular-file
changes only (max 20 tracked files, 96 KiB diff, no symlinks, untracked files,
deletions, renames or binary patches); run the approved verification gate.
On success the task waits in `VERIFIED_PATCH_AWAITING_REVIEW` with worktree
ID, exact HEAD, file list and patch size. It is **not** marked `succeeded`,
and does **not** push a branch, create a PR or merge.

If a command, status, quota, permission, checkout or verification fails,
the task is paused and the original working tree is unchanged. A process
restart will NEVER silently re-run a potentially mutating formatter after a
persisted checkpoint; it requires an explicit review/resumption procedure.
Finished but unreviewed worktrees consume one of the four existing lane
slots; review and safe cleanup are necessary for sustained operations.

## Limitations to close before full autonomous CI repair

1. CI ingestion is presently read-only through the separately authorized
   CircleCI/GitHub diagnostic readers. No automatic trusted, signed webhook
   or scheduled failed-PR detection has been wired to task creation yet.
2. A structured local-model patch proposal must be validated independently.
   The current worker intentionally accepts only explicitly approved
   deterministic fix recipes (e.g. a formatter), not arbitrary AI shell.
3. A lease-aware patch publisher and GitHub PR/create/review/merge queue is
   still required. Never push unresolved conflicts or dirty/unsafe diffs.
4. OS-level sandbox and network controls are required for genuinely untrusted
   repositories or third-party PR code. Git worktree isolation alone is NOT a
   process security sandbox; only trusted administrator-owned offline recipes
   may run here.
5. Continuous 24×7 behavior requires a running machine, approved agent
   service, enrolled project, free capacity, signed update, restart recovery,
   live authorization and observed soak tests. Merely merging source code
   does not install or activate the worker.

All changes are isolated from Claude's current dirty P720 checkout, existing
product/license databases and customer-facing production.
