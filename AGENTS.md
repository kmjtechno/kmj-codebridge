# KMJ CodeBridge — cross-client engineering entrypoint

This file is for coding agents and IDEs that support `AGENTS.md`. Keep `CLAUDE.md` compatibility, but use the latest explicit owner task and authenticated runtime evidence when older handoffs mention offline devices or superseded dates.

## One-call resume, then scoped execution

1. Identify authorized devices/projects with `list_devices`, or use `fleet_overview` once for multi-repository work. A connected device and available job slot are **not** a running coding worker.
2. Open `chat_workspace_open({device,project,lane:"codebridge-24x7"})` for the CodeBridge owner mission, or the existing stable project lane. For unrelated parallel changes use separate scope-specific lanes, checkpoints and branches. Use `multi_chat_sync` with `ifNoneMatch` when polling.
3. Prefer the saved revisioned mission and checkpoint. Re-read `docs/specs/KMJ-CodeBridge-Roadmap.yaml` only when its version or authoritative SHA changed, or no durable mission exists. Compile once per version, never enqueue duplicate tasks.
4. Recheck actual task ownership, Git HEAD, CI and live permission evidence before acting. `autopilot_claim` is not an AI executor; all scheduled/opt-in workers require independent runtime verification.
5. Reserve overlapping file paths; use isolated worktrees and exact SHA-bound changes. Run the smallest relevant approved language toolchain profile, then full repository checks and PR CI. No raw shell privilege or unrestricted repository command from chat.
6. Save a sanitized checkpoint after each milestone using `compact_session_save` with expected revision and exact next action. Never claim that checkpoint contents independently prove delivery.

## On-demand skills

- `.agents/skills/kmj-roadmap-memory/SKILL.md` — source-of-truth hierarchy, one-time mission compilation and fast cross-chat resume.
- `.agents/skills/kmj-multi-repo-hyperspeed/SKILL.md` — parallel project coordination, owner priority, locks, test evidence and cross-repo feature contracts.
- `.agents/skills/kmj-polyglot-execution/SKILL.md` — language/toolchain discovery and protected build/test profiles.
- `.agents/skills/kmj-openhands/SKILL.md` — optional OpenHands integration.

Read a skill only when relevant. Skill files are instructions, **not** proof that capabilities are installed, AI models are free, or background workers are running.

## Non-negotiable boundaries

- No paid inference, silent local inference fallback or confidential-source transfer to a cloud model without the separate verified owner-controlled authorizations. A zero-cost planning response is not billing proof.
- No bypass of tenant/device/project grants, safety review, branch protection, owner signing, Elite-only deployment, production release, or active owner pauses. Google VPS is for CloudOS testing only.
- Do not run `git reset --hard`, `git clean -fd`, force-push, delete owner files, or merge unreviewed changes.
- Every result should distinguish SOURCE, TEST, CI, AGENT_RUNTIME and PRODUCTION evidence, with current commit/PR and unresolved blockers.

See `docs/ENGINEERING-HYPERSPEED-AUDIT-20261123.md` and `docs/PERSISTENT-DEVELOPMENT-FLOW.md`.
