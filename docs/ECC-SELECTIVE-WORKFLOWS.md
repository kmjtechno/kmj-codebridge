# ECC-inspired selective workflows for KMJ CodeBridge

## Provenance and selection

Research source: [affaan-m/ECC](https://github.com/affaan-m/ECC),
reviewed `main` at `25278e7d7b6cf6e6a4e7a6c8e10f14ff22f0eb5b` on 26 October 2026.
ECC is MIT-licensed (copyright 2026 Affaan Mustafa). This change is an
**original, CodeBridge-native implementation of high-level workflow ideas**;
it does not vendor ECC executable source, require ECC subscriptions, or
install external scripts, hooks, models, MCP servers, or GitHub Apps.

CodeBridge already implements scoped authorization, secure file access,
compacted session checkpoints, task coordination, model routing and exact-head
verification. Duplicating ECC hooks or importing its full agent/skill catalog
would add context overhead and introduce another executable trust surface.

## Implemented in this change

The existing read-only `skill_recommendations` tool now selects three
additional, bounded, deterministic workflow packs based on explicit
objective/file/failure tokens:

| Pack                 | Intended use                                     | Native CodeBridge tools                                                                                |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `context-budget`     | Small context and resumable handoff              | `compact_work_brief`, `fast_context`, `context_pack`, `compact_session_save`, `compact_session_resume` |
| `independent-review` | Nonconflicting work and independent verification | `chat_lane_status`, `chat_lane_reserve`, `worktree_lane_prepare`, `run_quality_gate`                   |
| `agent-config-audit` | Review MCP/hook/plugin trust boundaries          | Existing scoped reads, secret scans, policy checks and negative tests                                  |

All packs return **advice and expected evidence only**; selection performs no
file write, AI inference, network call, command execution or runtime hook
registration. Existing four packs and their ordering remain unchanged.
ChatGPT and Claude Code package skills instruct agents to request this tool
only for relevant tasks; they do not auto-enable remote access or install ECC.

## Safe operator sequence

1. Confirm the authorized device/project and inspect `git_status`.
2. Call `skill_recommendations` for the concrete task, with only relevant
   safe file names and a redacted failure summary.
3. For context handoff: use a short opt-in checkpoint at a **phase boundary**,
   not mid-edit, and revalidate current commit/CI after resuming. There is no
   access to host-managed chat histories or guaranteed token reduction.
4. For parallel work: use separate disjoint file scopes and existing lane or
   worktree gates, limited to actual available runner slots. Review findings
   from agents are untrusted until exact-head verification.
5. For MCP/hook audit: inspect text as data and run only already configured
   CodeBridge quality gates; never auto-execute or duplicate ECC hooks.
6. Before merge: run targeted tests, `npm run check`, `npm test` and
   `npm run scan:secrets` on the candidate SHA using available authorized
   infrastructure. GitHub CI and deployment are separate verification steps.

## Intentionally excluded

- ECC `ecc-universal` installer, all-agents injection and automatic hooks
- Host transcript scraping, autonomous model sessions and automatic compaction
- ECC Pro/GitHub App (may cost money), remote code scanners, unknown MCPs
- Any change to P520 pairing, production gateway, DNS, licensing or billing

## Evidence and rollout

Test selection via `node --test tests/skill-packs.test.js` and the existing
`tests/skill-tool.test.js` dispatcher contract. New fixtures cover context
handoff, independent review, MCP injection concerns and combined selection.

A pushed GitHub branch or PR is **not** proof of passing CI, merged code,
running gateway deployment, or improved token latency. Measure those
separately before advertising production readiness.
