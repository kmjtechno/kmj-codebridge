# KMJ CodeBridge — Lease-bound local-first coding worker

This opt-in worker lets an already-enrolled writable project ask an explicitly
approved, already-running loopback Ollama model for a bounded unified diff.
It is local-only: there is no cloud fallback, package download, paid inference,
arbitrary shell execution, automatic commit, push, PR, merge, or deployment.

## Explicit administrator configuration

Add an **autopilotCodingWorker** object to one project in the protected agent
configuration. It requires all of the following:

- **enabled: true** and **localProcessingApproved: true**. Both are explicit; a
  missing consent flag prevents worker startup.
- **model**: the exact locally installed model identifier.
- **recipes**: one to eight named recipes. Each recipe names an existing
  administrator-approved **verifyGate**, an edit-path allowlist, and one
  to twelve exact tracked **contextPaths**. Every context path must also be in
  the edit allowlist.
- The project must be writable. The verify gate must already exist in
  administrator-owned project gates and must be a non-destructive test gate.

Example values (not a drop-in full agent configuration):

- Model: **qwen3:4b**
- Recipe name: **feature**
- Verification gate: **fast_check**
- Edit allowlist: **src/**
- Context files: **src/example.js**, **tests/example.test.js**

Only enqueue a task with the key **auto-code:RECIPE:FULL_40_CHARACTER_SHA**.
The immutable SHA must be the exact current source HEAD. A stale SHA fails
closed; a normal roadmap task is never interpreted as executable code.

## Execution and evidence

1. Check execute entitlement, explicit local-processing consent, the exact
   installed model, resource capacity, and the durable task queue before claim.
2. Claim one task with a time-bounded journal lease and create a fresh detached
   worktree at the exact requested SHA. The shared checkout is never edited.
3. Persist a no-replay checkpoint before inference. A missing model leaves the
   task queued. A process restart after a checkpoint pauses for review rather
   than repeating inference or file mutation.
4. Read only the configured exact context files. Context is limited to twelve
   regular tracked text files, 8 KiB per file and 32 KiB total. Environment,
   credential, private-key, database, log and encrypted-archive paths are
   rejected.
5. Accept only a bounded unified Git diff. New/deleted/renamed files, mode
   changes, binary patches, duplicate paths, symlinks, untracked files and
   paths outside the explicit allowlist are rejected. Git independently checks
   and applies the patch inside the isolated worktree.
6. Run only the configured administrator-approved verification gate. Recheck
   the exact HEAD and patch digest after the gate.
7. Persist the file list, patch size, SHA-256, verification job ID and local
   model receipt, then pause in **VERIFIED_PATCH_AWAITING_REVIEW**. The
   existing read-only **autopilot_repair_candidate** tool can inspect the
   candidate. It is never automatically published or marked as a completed
   product feature.

The worker serializes local coding with other project jobs and honors update
maintenance admission. It records a local-ollama / local-only / no-paid-
inference receipt only after successful local generation; it does not identify
the host chat application's model.

## Qualification limits

A green source test suite proves the worker's code contract, not that any
device has the feature installed or an Ollama model available. Confirm the
exact signed installed revision, **coding** runtime handle, a real lease-bound
candidate and independent gate result, then exercise restart recovery on the
authorized device. Until those observations exist, keep
**NO_AUTONOMOUS_CODING_EXECUTOR** open.

Git worktrees are change isolation, not an OS-level sandbox. Enable only for
trusted repositories and tightly allowlisted files and gates. Keep a human
review before any authorized PR flow, and never run this worker against
production secrets, live customer data, or deployment gates.
