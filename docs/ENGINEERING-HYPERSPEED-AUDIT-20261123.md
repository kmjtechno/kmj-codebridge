# KMJ CodeBridge — engineering hyperspeed audit and implementation backlog

Audit date: **2026-11-23**. GitHub base: `7ebb7c7f89007aad3c7d5de3f54e8ebff4587306`. This is a scoped repository/docs/runtime audit and change proposal, **not a full dependency-level security audit or a production release**.

## Verified runtime observations at audit time

- `list_devices`: nine enrolled device/project pairs, eight operational and the VIOSO P520 agent offline.
- `fleet_overview`: eight authorized free job slots, five actionable project lanes, no actual work launched by the read. These are capacity slots, **not** five running AI coders.
- P520 CodeBridge `autopilot_worker_runtime_status`: `gate`, `repair`, `githubCiWatch`, `localDraft`, `coding` all have `loopStarted=false`; `coding.configured=false`.
- P520 CodeBridge `chat_workspace_open(lane="review-hyperspeed")`: `NO_SAVED_CHECKPOINT`, no deployed coding worker verified; local CodeBridge checkout runtime revision `4f0a96ceba203315262da219d51b554e716355c9`.
- P520 shared `codebridge-24x7` lane contains a Nov 18 owner-release checkpoint but not the current Nov 23 hyperspeed mission. A revisioned update is needed; old releases require fresh Git/source evidence before claiming status.
- `autopilot_status` shows queued and waiting historical release tasks; some task wording references superseded PRs and needs reconciliation before claiming. No task is completed merely by a claimed status.
- Current GitHub main and a P520 installed revision differ. Treat source, authenticated running gateway, installed agent and signed publication as independent evidence.
- `docs/specs/KMJ-CodeBridge-Roadmap.yaml` is version `1.3.0`, last updated Nov 8, while `CLAUDE.md` still opens with an Oct 12 P720-first task. Owner-approved priority changed; maintainers should reconcile instructions instead of inferring retired device readiness.

## Existing strengths: preserve, do not rebuild

OAuth/tenant/device permissions; project-scoped read and SHA-checked edits; signed quality gates; Git/file reservations and isolated worktrees; mission DAG and leases; per-project compact checkpoints; `chat_workspace_open` and `multi_chat_sync`; repo map/HyperIndex; verified-candidate model adapters; GitHub exact-head CI; protected signed releases.

Key docs already exist: `AUTOPILOT-ROADMAP.md`, `PERSISTENT-DEVELOPMENT-FLOW.md`, `MULTI-REPO-AUTOPILOT.md`, `MULTI-CHAT-LANES.md`, `VERIFIED-FREE-CLOUD-AUTONOMOUS-CODING.md`. Their existence is not proof that background engineering is active.

## P0: real coding, durable context, no uncontrolled spending

1. **Actual model-backed executor:** keep the zero-cost cloud-only owner preference. Trusted account-bound no-charge verifier + source-transfer consent + exact chain membership must be established *before* enabling existing `autopilotCodingWorker`. Prove real coding patch, isolated safe gate, restart recovery and authoritative provider cost; default deny with no approved route. Never enable Ollama fallback silently.
2. **Once-per-version roadmap:** use versioned mission compilation from the authoritative roadmap, stable per-project checkpoints and `ifNoneMatch`. Add automatic stale-task reconciliation against latest owner priority. Verify no duplicate enqueues, correct cross-chat pickup and audit provenance.
3. **Real local service:** an opt-in authorized daemon must actually start and be monitored via service state and task receipts. Scheduled chat prompts, planner waves and queue sizes alone are not 24x7 autonomous work. Persist checkpoints and resume without chat-awakening claims.
4. **Current-release parity:** reconcile source main, signed deployed gateway, Elite agent and P520 agent. Show exact SHAs and tool capability gaps in one status panel; never quietly assume that a merged PR is installed.

## P1: multi-repository, polyglot, speed

5. **Cross-repo contracts:** one `KMJ-FEATURE-id` owner spec, per-repo dependency tasks, linked PR/CI evidence, owner priority arbitration and independent release gates.
6. **Toolchain matrix:** detect Node, Python, PHP, Rust, Go, Java, CMake/Qt, .NET, Swift, Kotlin and relevant SDKs; extend fixed approved QA profiles on compatible devices, then test on representative projects. No universal-language success claim until exercised.
7. **Code intelligence:** benchmark the existing repo map/HyperIndex; consider incremental Tree-sitter/LSP/ast-grep adapters, changed-file dependency impact, cache invalidation on commit SHA, and path-constrained retrieval. Avoid default installation overhead.
8. **Skills:** adopt portable Agent Skills (`SKILL.md`) with progressive disclosure: roadmap-memory, multi-repo-hyperspeed and polyglot-execution. These are instructions now, not a new paid model or installed runtime service. Add evaluated runtime skill recommendations after tests.
9. **Performance:** compare baseline vs changed p50/p95 task pickup and end-to-end fix time, context bytes, model tokens, missed dependencies, CI retries, merge conflicts, RAM/CPU and dollars actually spent.

## P2: deprecation candidates — NOT approved for blind deletion

- P720-only installers and scripts: inventory references, platform compatibility, use by existing offline devices and rollback before removal; put a deprecation notice first.
- Hard-coded PR-number Supervisor CI helper endpoints and historical release-by-sequence workflows: consolidate only when exact-SHA generic profiles demonstrate functional parity, branch protection and security gates.
- Multiple overlapping context, continuity and handoff presentations: unify the user-facing entrypoint while keeping legacy MCP aliases until enrolled agents/clients have migrated.
- Any legacy local inference auto-fallback that conflicts with the latest owner policy: disable only where policy and running config independently confirm; preserve explicit optional support for customers who approved it.
- Keep signed release archives, key-trust material and security audit history regardless of UI/tool simplification.

## External GitHub design references (research, no upstream code copied)

- [Aider](https://github.com/Aider-AI/aider): repository maps, architect/editor split, lint/test feedback and focused commits.
- [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk): modular tool/workspace boundary and agent event streams.
- [SWE-agent](https://github.com/SWE-agent/SWE-agent): issue-centered executable problem-solving and regression benchmarks.
- [Continue](https://github.com/continuedev/continue): IDE/CLI integration, project rules and configurable tools/models.
- [Agent Skills specification](https://github.com/agentskills/agentskills): portable on-demand `SKILL.md` format.
- [GitHub Spec Kit](https://github.com/github/spec-kit): spec/plan/tasks/review.
- [LangGraph](https://github.com/langchain-ai/langgraph): per-thread checkpoints distinguished from cross-thread durable storage.
- [ast-grep](https://github.com/ast-grep/ast-grep): optional cross-language structural search and codemod.

Verify upstream licenses, dependency advisories, runtime versions, data exposure, resource impact and exact integration tests before adopting code or packages.

## Acceptance gates

- **P0:** attested no-charge and privacy-approved actual model call, safe patch and test receipts; real 24x7 loop service started and reboot/recovery tested on enrolled hardware.
- **Resume:** two separate clients resume the same versioned mission without rereading the unchanged roadmap; stale lease/CAS and wrong-tenant scope are rejected.
- **Parallel:** two authorized repos deliver independent PR/contract receipts without overlapping-write loss or duplicate tasks.
- **Polyglot:** at least one fixed-profile real test per supported language/OS matrix row.
- **Cleanup:** reference inventory, regression suite, deprecation window and rollback before deletion.
- **Release:** exact-head green GitHub CI, independent review, owner signing and separate signed Elite deployment verification.

No production services, signers, device enrollment, accounts or GitHub default branch are changed by this documentation/skills PR.
