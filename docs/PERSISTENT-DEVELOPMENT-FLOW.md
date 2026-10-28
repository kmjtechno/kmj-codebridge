# KMJ CodeBridge — One-Call Durable Development Roadmap

**Goal:** stop repeatedly reading a GitHub roadmap and losing project decisions between AI chats. This is a no-cost, local-first, **claim-aware** development workflow. It does not lengthen ChatGPT/Claude model memory or wake sleeping chats.

## Sources of truth — keep them separate

1. **Locked product decisions/specs:** reviewed repository docs and approved owner constraints. Do not rewrite locked UX, branding, zero-cost constraints, credentials or release gates based on a conversational guess.
2. **Durable project roadmap checkpoint:** a bounded revisioned record saved on the authorized CodeBridge device, scoped by `device + project + lane`. Each new chat can read it with one `chat_workspace_open` or `multi_chat_sync` call instead of rereading a repository roadmap.
3. **Actual current execution:** authorized project task journal, file reservations, Git state and CI/production receipts. A saved checkpoint is a _client-reported summary_, not proof that work completed.
4. **Production approval:** separate owner-controlled signed release and rollback controls. Neither the roadmap nor a queued task grants deployment authority.

## Minimal day-to-day workflow

1. **At start or any project change:** use `chat_workspace_open({device,project,lane})` once. Read `developmentFlow.roadmap` and `developmentFlow.recommendedAction`, authenticated project status, live capabilities and checkpoint revision. Alternatively use `multi_chat_sync` for compact multi-chat polling. No automatic GitHub roadmap reread when a saved checkpoint is present.
2. **Plan:** compare the saved next step with actual task journal, current exact source SHA and new issue/CI evidence. `CHECKPOINT_SAVED_UNVERIFIED` means the intent was retained, not proven. `REVIEW_REPORTED_BLOCKERS` is the safe first recommendation whenever recorded blockers exist.
3. **Work:** choose one scope-bounded task, reserve overlapping files, edit with SHA preconditions, run focused and full quality gates, and link evidence to task/mission. Respect existing session IDs and idempotency keys. Parallelize only independent tasks within real slot capacity; never pretend queued work is autonomous coding.
4. **Checkpoint after milestone:** prefer `compact_session_resume` then `compact_session_save` with CAS revision and durable `objective, summary, decisions, constraints, evidence, blockers, nextSteps`. If an older connected agent returns `UNKNOWN_TOOL`, use `chat_continuity_read` and `chat_continuity_save` with `expectedRevision`, keeping `summary,next,blockers` bounded. Do not ask the user to paste raw chat transcripts, secrets or root output.
5. **Next chat:** reuse the same scoped lane; call `chat_workspace_open` once and continue from the saved proposal. If the response is `unchanged`, use existing digest; if source changed since last check, independently verify exact-head CI and release state before acting.
6. **When blocked:** store the exact blocker, next safe action and evidence ID. Fail closed; never bypass owner approval, signing, rollout, tenant scope or billing restrictions.

## Runtime coverage

- `src/development-flow.js` builds a bounded, provenance-labelled action from already-authorized data. The same `developmentFlow` object is returned by gateway-side `chat_workspace_open` and `multi_chat_sync`.
- The guide intentionally does _not_ add new backend polling, vector DBs, model downloads, OAuth scopes or remote service calls. It works with compact session or legacy continuity on older agents.
- Roadmap claims are sanitized. Foreign-project/lane or malformed revisions are ignored. Live task IDs are surfaced only from authorized local task journals; no automatic worker claim or production activation.
- For a complete project, use the existing `mission_compile`, `mission_status`, `mission_evidence` tools to persist dependency DAG and acceptance criteria **only after confirming an authorized device/worker and non-destructive owner gates**. Do not auto enqueue sensitive root/deployment tasks.

## Open-source research behind the design

- [LangGraph persistence](https://github.com/langchain-ai/langgraph): separate thread checkpoints and cross-thread stores; adopt the distinction, not the runtime stack.
- [GitHub Spec Kit](https://github.com/github/spec-kit) and [OpenSpec](https://github.com/Fission-AI/OpenSpec): spec -> scoped tasks -> evidence -> convergence; use lightweight templates and owner-locked intent without installing new tools.
- [Ruflo](https://github.com/ruvnet/ruflo): durable agent coordination and event sourcing; avoid an oversized swarm or claimed speedup without measurement.
- [Graphiti](https://github.com/getzep/graphiti): temporal provenance patterns; not needed for the current small bounded roadmap because it adds a graph database/model dependency.
- [OpenHands](https://github.com/OpenHands/OpenHands): separate the UX from the authorized runtime and sandbox; don't treat an attractive chat UI as a working coding executor.

**No upstream code copied.** Re-evaluate actual license and security before adopting any library.

## Definition of Done

- [ ] Exact-head Linux/Windows CI tests for one-call resume, legacy compatibility, scope isolation and secret redaction are green.
- [ ] Approved CodeBridge gateway source containing `developmentFlow` is deployed and authenticated live MCP verifies it; source merge alone does not activate it.
- [ ] Project checkpoint on an enrolled authorized device exists and can be resumed after a new chat, without reading GitHub on unchanged state.
- [ ] Task journal and production release claims remain explicitly separated; owner release gates are not bypassed.
- [ ] Benchmark actual resume latency/token savings before claiming hyperspeed; no fabricated performance numbers.
