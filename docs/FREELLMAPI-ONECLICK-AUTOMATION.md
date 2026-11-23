# KMJ Model Fabric — one-click intelligent engineering workflows

Status: source-only candidate. This does not start a coding worker, install FreeLLMAPI, make cloud requests, create/merge pull requests, or deploy anything.

## Automatic user workflow

**One prompt**: owner selects an approved CodeBridge device/project and writes an objective in Hindi/Hinglish or any language. The caller may submit an English summary or task context suitable for the deterministic existing engineering selectors. No agent can infer authorization from the text alone.

1. `skill_recommendations` returns legacy seven packs and nine curated FreeLLMAPI-only skills, plus an `automaticPlan` outlining task class, at most three relevant workflows, required QA and distinct signing/production gates. It is read-only. No cloud call, file mutation or silent provider selection.
2. The user/app can explicitly invoke `freellmapi_generate({ device, project, prompt, autoSkill:true, localProcessingApproved:true, upstreamCloudApproved:true })`. This opt-in adds a bounded reviewed multi-skill prompt and chooses `code`, `reasoning`, or `general` automatically. Existing callers with no `autoSkill` remain unchanged. Explicit `skillId` and auto mode are mutually exclusive.
3. The existing FreeLLMAPI loopback client alone discovers approved `auto:<chain>` profiles and obtains a separate authenticated **zero actual upstream charge, quota, immutable members and no paid fallback** receipt before each cloud POST. If unavailable, fail closed. This is NOT granted by caller booleans or a router's 'free model' advertisement.
4. Returned text is **untrusted**. The current tool does not apply patches or run shell commands. Existing approved SHA-guarded CodeBridge workers/QA, exact-head CI, reviewer signoff, and Elite-owner signing remain separate operations. A future delegated worker must prove consent and clean isolated lane before claiming genuine 24/7 coding.

## What is fully automatic in this source slice?

- Matching the most relevant bounded language/engineering skill from a single task description, no manual skill ID needed.
- Limited multi-domain workflow composition (max three), with a deterministic security-review priority when relevant.
- Task-aware generation routing through the single FreeLLMAPI gateway **only after** all existing grants.
- One-shot evidence/QA plan without re-reading all upstream roadmaps or installing remote skill code.

## What remains gated or not built?

- Enabling nonlocal cloud code upload or authorizing a new account: requires owner/project/provider consent and trusted billing proof, _not_ a prompt saying 'approved'.
- Continuous scheduler + coding worker integration, restart/replay, automatic PR creation and full automatic test fixing: not added in this PR, must integrate with existing signed worker/lease state. A chat timer or an automated plan is not genuine coding.
- Running arbitrary tools suggested by a remote model: intentionally disallowed; only preapproved fixed profiles and validated patches in isolated worktrees.
- Production signing, deployment, destructive operations, new paid providers and secret access remain separately authorized; do not treat this as 'one click auto deploy'.

## Verification

`node --test tests/fabric-auto-workflow.test.js` plus full `npm run check`, existing tests, Linux/Windows CI and independent review. Simulated no-charge attestors in unit tests do **not** prove a live provider is free.

Cross-reference: [full upstream workflow](FREELLMAPI-FULL-MODEL-FABRIC-WORKFLOW.md) (in separate PR #1157), [source skill fabric](FREELLMAPI-SKILL-FABRIC.md), and activation issue #967.
