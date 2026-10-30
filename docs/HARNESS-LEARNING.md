# Evidence-based agent learning (Harness²-inspired)

This CodeBridge-native slice uses ideas from
[Google Research Harness²](https://github.com/google-research/harness2),
reviewed at upstream commit `1cfe254e8d25b15f37048c3730134686abe60335`.
The upstream is Apache-2.0; **no third-party source is bundled**.

## Scope

Four project-scoped MCP tools:

- `harness_learning_review` compares a caller-reported baseline with a
  proposed candidate using the same task, source SHA, policy digest and gate.
- `harness_learning_record` stores a sanitized improvement hypothesis with
  the evidence digest, only for an authorized writable project.
- `harness_learning_list` returns bounded, untrusted, historical learning hints.
- `harness_learning_revoke` disables an obsolete hint without deleting history.

The device agent stores at most 16 hints per project under its existing private
state directory. All updates require revision compare-and-swap and idempotency
keys. Storage is bounded, hash-checked, atomic and rejects unsafe symlinks.

The learning journal is a **hint store, not an automatic policy engine**.
No saved hint is a prompt with privileged authority. All trial metrics are
caller-reported and cannot independently prove CI or production release.

## Proposed workflow

1. Use the existing approved CodeBridge task and protected source HEAD.
2. Run a baseline and candidate in isolated worktrees with the exact same
   task fixtures, gate configuration, model route and measured cost.
3. Call `harness_learning_review` with sanitized metrics and digests.
4. Record a review-worthy candidate only after inspecting independent gate
   evidence; it stays `pending_review` until separately verified.
5. Read recorded hints while preparing future work, and reverify against
   current source and CI. Revoke stale or unsafe hints.

The initial release does **not** auto-run multiple model rollouts or generate
candidate prompts, and does not pretend to implement the research paper's
entire optimization loop. It supplies the bounded review and experience layer.

## Security and cost controls

- No new AI provider or API charges; the module makes zero model/network calls.
- No arbitrary shell or sandbox bypass; existing fixed quality gates remain.
- No change to owner approval, tenant/project scope, licensing or deployment.
- No external memory database or raw chat transcripts.
- Read and write calls are guarded by existing MCP permissions and audited.
- Never trust a caller's `passed` flag as a signed CI or live acceptance receipt.
- Avoid upstream unrestricted-network and unconfined Codex execution options.
- Preserve signed runtime, updater and rollback release gates.

## Verification

Run `node --test tests/harness-learning.test.js` and the full repository
`npm test`, `npm run check`, and `npm run scan:secrets`.
A source CI success is **not live activation**. The signed installed device
agent and gateway catalog must independently report the same exact commit and
serve these four tools before calling the feature live.
