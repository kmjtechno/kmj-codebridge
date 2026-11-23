---
name: kmj-roadmap-memory
description: Resume KMJ CodeBridge project work across independent AI chats without repeatedly re-reading unchanged roadmaps; validate checkpoint versions and current Git evidence.
---

# Roadmap once, resume many times

Use this skill for project handoffs, interrupted tasks, roadmap-driven work, new chat sessions and context recovery. This is a workflow using existing authorized CodeBridge tools; installing the skill does not start a model or service.

1. Find the **authorized** `device` and `project` through `list_devices` or an existing fresh fleet snapshot. Never infer permission from a repository URL.
2. Use a stable per-project mission lane (CodeBridge's owner lane is `codebridge-24x7`), and call `chat_workspace_open` once. Read `developmentFlow.roadmap`, current task journal, capability revision and next action. Only use `multi_chat_sync` for changes, passing `ifNoneMatch` when supported.
3. Prefer a valid saved checkpoint and mission for the unchanged roadmap version. If missing or inconsistent, read the **authoritative repo roadmap**, resolve its version and exact source SHA, then compile one idempotent `mission_compile` task DAG. Do **not** compile identical open tasks in every chat. An amended roadmap invalidates affected tasks and requires a reviewed versioned delta, not blind replay.
4. Distinguish immutable owner decisions and accepted specifications, caller-reported checkpoint facts, live device task status, exact source/CI receipts and production signing authority. A checkpoint is never execution proof.
5. Claim only an approved dependency-ready task with a stable holder and lease; preserve the lease token privately, checkpoint regularly, and wait with a precise blocker rather than spinning. Concurrent chats must use independent file scopes/worktrees and must not double-claim.
6. After each milestone, save `objective`, `summary`, decisions, constraints, evidence references, blockers and next steps via `compact_session_save` with the current `expectedRevision`; use the legacy continuity fallback only if the enrolled agent actually lacks the new tool. Never store secrets, email addresses or raw transcripts.
7. On a new chat, reopen the same lane, check current Git/CI/runtime before editing, and continue the next action. If no running worker exists, report that accurately; an AI chat cannot auto-wake itself.

**Acceptance:** two independent authorized chats resume the same unchanged roadmap revision with no full reread; a stale CAS update fails; no cross-project leakage; verified CI/source and production states remain separate. Measure context bytes and task pickup latency before claiming speed gains.

References: `docs/AUTOPILOT-ROADMAP.md`, `docs/PERSISTENT-DEVELOPMENT-FLOW.md`, `docs/specs/KMJ-CodeBridge-Roadmap.yaml`.
