# KMJ Engineering Observer — Zero-cost, read-only skill improvement proposals

## Upstream research and attribution

This design is independently implemented for KMJ CodeBridge after reviewing
[Eoghan Henn / rebelytics, Task Observer (“One Skill to Rule Them All”)](https://github.com/rebelytics/one-skill-to-rule-them-all),
originally v3.7.0 (commit `3463c7c9cd2a2c2745af09c742100ad0b1465a68`)
and now v3.8.0 (tagged source commit `ac00bed07526475a6679a3dc018e145f5e0a672f`).
Upstream is **CC BY 4.0**, not Apache or MIT; attribution matters for
derivative copied materials. No upstream scripts, text blocks, assets or
binaries are bundled in this implementation. The _methodology_ inspires
event logging, recurring-friction review, fail-closed structural guards,
and staged human approval.

## Implemented on this source branch

`src/engineering-observer.js` analyzes at most 32 structured signals in
one memory-only, deterministic pass. It neither reads raw agent logs nor
stores user prompts, credentials, incidents or other project data.

An optional `observations` array on the existing read-only MCP
`skill_recommendations` tool enables the analysis on upgraded agents.
Without this argument, the existing tool's response is unchanged.

Each event has exactly these seven fields:

```json
{
  "eventId": "evt-00000001",
  "project": "kmj-codebridge",
  "sessionId": "chat-00000001",
  "skill": "debugging",
  "kind": "ci_failure",
  "causeCode": "CI_RUNNER_PRESTART",
  "evidence": "REPRODUCED"
}
```

- The tool's already-authorized `device` and `project` gate remains
  authoritative. Embedded event project mismatches fail the entire review.
- `skill` is an existing, known pack; `kind` and `evidence` are
  allowlisted; `causeCode` is bounded machine-safe taxonomy, **not** a
  log excerpt. Extra fields and raw user text fail closed.
- Same event ID and identical payload is an idempotent retry; same ID
  with changed content is a conflict. Recurrence is counted only from
  distinct session IDs with **caller-asserted** evidence.
- At least two distinct sessions with asserted evidence recommend
  `STRUCTURAL_GUARD_REVIEW`; otherwise `EVIDENCE_COLLECTION`. A guard is
  **not written, staged or installed** by this module. Suggestions always
  require actual source review, negative regression tests, exact-head CI
  and a rollback plan.
- Caller assertions do not attest CI, session identity, user approval or
  production safety: `externalEvidenceVerified:false` is mandatory.
- The tool does not route AI models, add GitHub Actions capacity, update
  autonomous workers, change P720 Windows agents, migrate PostgreSQL,
  write any file, send data to an API, or activate any skill.

## v3.8-inspired candidate review (opt-in, backward compatible)

When the existing authorized caller includes `observations`, the same
deterministic analysis also returns two *review-only* lists:

- `newSkillCandidates`: only explicit `skill_gap` observations propose a
  possible new skill design. A matching existing skill is the **context** of
  the gap, not a pre-approved new skill name. At least two distinct sessions
  with asserted evidence are needed before `NEW_SKILL_DESIGN_REVIEW`;
  otherwise the candidate remains `EVIDENCE_COLLECTION`.
- `crossCuttingCandidates`: a machine-safe cause code seen under at least
  two existing skills may indicate a reusable cross-skill rule. It requires
  asserted evidence from **two skills and two independent sessions** to reach
  `CROSS_SKILL_REVIEW`; all other cases remain evidence collection. An
  identical cause code is not proof of a shared root cause.

These lists carry only bounded, already-authorized signal metadata and stable
candidate IDs. They never copy raw session text, auto-generate executable
rules, install skills, write an observation store, contact a service, or
promote caller-supplied assertions to verified evidence. Existing
`proposals` and omitted-`observations` tool behavior are preserved. Each
candidate requires scope review, negative tests, isolated staging, exact-head
CI, rollback, and explicit approval before a separately implemented install.

**Upstream mechanisms deliberately not imported:** shell/Python workspace
scanners, ambient session hooks, global cross-project logs, automatic local
file mutations, scheduled reviews, and upstream activation instructions.
Those could exceed customer device/project grants, leak multi-tenant data or
increase per-chat token usage. If needed, first design a tenant-scoped,
redacted, opt-in persistence and review contract with tests and permission
gates; do not use raw conversations as executable instructions.

## Reliable integration path

1. Preserve CodeBridge authoritative task/CI/agent evidence and current
   skill catalog. Parse only explicit bounded signals into the observer;
   never let a log, PR body, remote webpage or AI-generated text become
   executable instructions.
2. After independent verification, persist redacted events through a
   separately authorized and project-scoped durable store. The pending
   Main Platform PostgreSQL Knowledge Memory PR #443 is **NOT** treated as
   merged, deployed or production-ready. No dependency on that PR here.
3. Plan a review-only Mission Control page with candidate diffs, baselines,
   historical failure counts and per-skill scope; never auto-install skills.
4. Stage signed/hashed skill candidates in isolated branches with validation
   and exact-head Linux + Windows CI; require owner approval before
   enabling. Do not permit one observer to self-approve its own revisions.
5. Benchmark before/after time-to-first-useful-tool, mean/p95 overhead and
   recurrence reduction on equal tasks. No unmeasured "hyperspeed" claim.

## Validation and licensing

Local focused tests:

```sh
node --test tests/engineering-observer.test.js tests/skill-tool.test.js
```

Required project checks: `npm run check`, `npm test`, packaging,
secret scan, Windows/Linux exact-head CI. No additional paid services,
servers, models, credentials or GitHub runners.

This document names upstream to credit the original CC BY 4.0 project.
The KMJ-specific implementation is not claimed to be officially affiliated
with that project, nor to include the original observer's full feature set.
