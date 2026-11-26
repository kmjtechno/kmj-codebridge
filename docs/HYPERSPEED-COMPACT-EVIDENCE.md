# HyperSpeed: evidence-first compact read results

This slice extends the existing opt-in compact and adaptive read modes rather
than adding new MCP tools or changing the legacy full response contract.

A routine compact Git status or project snapshot retains dirtiness, tracked
and untracked status-row counts, conflict counts, and explicit numeric
ahead/behind evidence when present. Counts describe porcelain status rows, not
a complete recursive file inventory. Unreadable or malformed status must not
be represented as a clean tree. Branch names and paths remain absent from
compact results. Execution capacity retains bounded scheduling counts and
available slots without copying arbitrary reasons or private metadata.

Clients should select adaptive mode for routine status polling and full mode
when source, exact file paths, exact HEAD, CI logs, or release evidence is
needed. A compact receipt is not permission, completion, or deployment proof.
The existing byte-saving threshold remains unchanged.

## Live baseline (2026-11-26, one three-read sample)

- Full: 49,607 bytes, 637 ms.
- Auto: 1,152 bytes, 831 ms.
- Compact: 1,155 bytes, 700 ms.

These are measurements of the existing CodeBridge connector response, not
ChatGPT inference latency or the changed candidate. The candidate must pass
exact-head regression tests and be independently benchmarked after rollout.
No paid AI, transcript ingestion, permission relaxation, or chat UI control is
introduced.

## Continuity capacity

The existing checkpoint format and revision checks remain unchanged. Device-wide
capacity grows from 32 to 256 lanes, with a maximum of 16 KiB per packet
(4 MiB of packet payload). Existing lanes remain readable and updatable at
capacity; new lanes fail closed at the limit. No automatic eviction, deletion,
or unverified active-lane classification is introduced. Reuse stable lane IDs
and conditional resume to avoid needless new checkpoints.

## Upstream research and adoption gates (2026-11-26)

- Symphony (Apache-2.0): https://github.com/openai/symphony — compare issue
  scheduling, retry budgets, and isolated workspace lifecycles with native
  mission and worktree lanes. Do not add a second scheduler.
- Aider (Apache-2.0): https://github.com/Aider-AI/aider — evaluate ranked
  symbol maps against the existing repo map and HyperIndex.
- RTK CLI (Apache-2.0): https://github.com/rtk-ai/rtk — evaluate deterministic
  command-specific projections; exclude separately licensed engines.
- ast-grep (MIT): https://github.com/ast-grep/ast-grep — pilot read-only
  structural search on Rust, C++, PHP and TypeScript before scoped rewrites.
- Context Mode (Elastic-2.0): https://github.com/mksglu/context-mode — design
  reference only; no upstream source or package incorporated.
- OpenHands: https://github.com/OpenHands/OpenHands — evaluate sandbox and
  agent lifecycle patterns; review each component license before reuse.
- OpenCode (MIT): https://github.com/anomalyco/opencode — compare provider and
  tool adapters; retain KMJ ModelFabric as the sole provider control plane.
- ACP (Apache-2.0): https://github.com/agentclientprotocol/agent-client-protocol
  — evaluate protocol interoperability with explicit scoped grants.
- Agent Skills: https://github.com/agentskills/agentskills — validate skill
  manifests and individual licenses; skills never grant execution authority.

Native integrity-manifest compact receipts preserve bounded file and byte
counts, truncation and recognized coverage labels without disclosing paths.
A bounded scan is not evidence of whole-repository coverage.

Before integrating any dependency, pin an immutable revision, inspect its
license and transitive dependencies, verify signed distribution and run
independent Linux/Windows regression gates. Compare p50/p95 tool latency,
response bytes, task completion, defect rate and cost against a fixed baseline.
These references are candidates, not installed dependencies or performance
claims. No local LLM, paid provider, blanket permissions or extra service is
required by this change.

## Request-local duplicate suppression

Compact and adaptive batches share the result of identical scoped file reads
within one request only (file content, range, tail, and metadata). Each caller
key retains its own response row. Full mode and other read tools retain their
original execution behavior. Results and errors are not cached across requests,
users, devices, or projects; failures remain failures and the next request may
retry. This avoids duplicate agent round trips without a persistent private
source cache. Independent calls still run in parallel.
