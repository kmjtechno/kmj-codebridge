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
