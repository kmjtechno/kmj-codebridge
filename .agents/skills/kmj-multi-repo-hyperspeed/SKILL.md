---
name: kmj-multi-repo-hyperspeed
description: Coordinate parallel work across multiple KMJ GitHub repositories, IDEs and AI chats with bounded task leases, worktree isolation, dependency contracts and exact-head verification.
---

# Multiple repositories without collisions

Use for a feature spanning CodeBridge, Main Platform, OmniDesk, CineCore, Calibration or CloudOS. Do not interpret parallel chat sessions as multiple active AI workers or free model quotas.

1. Read `fleet_overview({maxProjects:12})` once. Select project work by the latest explicit owner priority, actual grants and current lane status; snapshot `nextWork` is **advisory**, not a global scheduler.
2. For each selected project call `chat_workspace_open` with its *existing stable lane* and `autopilot_status` to verify dependencies, owner pauses and next claim. Confirm device is online, model route permitted, and runner slots really available.
3. Represent cross-repo features with `KMJ-FEATURE-<id>` in an owning specification, including consumer repositories, API/SDK contract, backwards compatibility, negative tests, version constraints, accepted UX and release requirements. Use a per-repo DAG and linked PR/SHA receipts. There is no cross-repo atomic commit.
4. Partition independent tasks by **repo + branch/worktree + file scope**. Reserve overlapping CodeBridge-managed paths with `chat_lane_reserve` and apply hash-precondition writes. External IDEs/Git commands are not protected by CodeBridge file reservations, so separate branches and conflict checks remain mandatory.
5. Share only bounded, sanitized coordination summaries: feature ID, owning scope, API contract, blocker, task ID, exact PR/head SHA and next dependency. Do not export private code, credentials or production data to other projects or agents.
6. Run approved focused tests per language, cross-repo integration/contract checks and exact-head GitHub CI for each changed repo. Check PR review/merge policy independently. Signed Elite publication remains separate from merging.
7. Persist milestones via `compact_session_save` in the correct project lane. Before marking a parent feature done, verify *all* consuming repo receipts, not just the producer PR.
8. If no consented/verified free inference executor exists, stop at planned or reviewed work; never mark a simulation or queued task as completed coding.

**Acceptance:** two distinct authorized repos each produce a traceable PR, matching contract tests, conflict-free isolated edits, separate fresh checks and a resumable handoff. Record latency, duplicated work and CI reruns against a baseline.

References: `docs/MULTI-REPO-AUTOPILOT.md`, `docs/MULTI-CHAT-LANES.md`, `docs/HYPERSPEED.md`.
