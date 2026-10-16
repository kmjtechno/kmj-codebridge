# KMJ PostgreSQL Knowledge Memory integration boundary

**Readiness: source-only preview formatter. No live PostgreSQL connector or MCP tool.**

The Main Platform branch `feat/knowledge-memory-postgres-20261017` (PR #443)
implements an isolated PostgreSQL knowledge store. It draws on useful
Engram architectural ideas without adding Engram Cloud, installing its Go
binary or copying its MIT-licensed code.

CodeBridge already manages authoritative worktree leases, chat continuity,
CI evidence, device grants, file checkpoints and autonomous queues.
**Do not treat retrieved knowledge as authoritative execution state.**

## Safe project-scoped protocol

- A future Main Platform route must authenticate the real user/service,
  require an active CodeBridge entitlement, resolve organization membership,
  and enforce explicit per-project authorization. Call the Main Platform
  knowledge store only after that host-owned check; never allow arbitrary
  projects or trusted-scope flags from an AI prompt.
- Send the response as project-scoped observations with
  `organization_id`, `project_key`, `observation_id`,
  `topic_key`, `type`, `title`, `preview`, `revision`.
  The public API does **not exist yet**.
- `src/knowledge-memory-brief.js` only performs bounded client-side
  presentation and checks for mismatched provenance. It does NOT authenticate
  the underlying identity, access PostgreSQL or prove memory is safe.
  Unknown, foreign or conflicting records cause a hard error.
- Memory can be stale, inaccurate or prompt-injected. Use it only as
  historical context; verify live Git status, CI, authorization, billing,
  device state, deployment and queue leases through their existing sources.
- No secrets, raw ChatGPT transcripts, automatic prompt capture, git export,
  personal scope sync or background model calls. Do not accept an Engram
  `personal` label as a privacy boundary.
- Reject risky inputs; curated data must undergo privacy review **before**
  any memory write. Text redaction is defense in depth, never proof of safety.

## Manual source-level test

```sh
node --test tests/knowledge-memory-brief.test.js
```

The compact formatter is deterministic, digestible and contains no network
calls, DB connections, task execution, new tool registration or filesystem
writes. The default pipeline and ChatGPT tool inventory are unaffected.

## Production activation gates (separate PRs)

1. Owner-approved API contract with authenticated tenant+project grants.
2. PostgreSQL migration on **disposable QA database** with real FTS tests,
   p95 queries and backup/rollback rehearsal before production.
3. Real-device staging read-only MCP discovery; verify normal host OAuth
   and genuine project authorization, then bounded memory retrieval.
4. Explicit consent-gated memory writes, structured conflict review and
   retention after security tests. Never silently ingest user prompts.
5. Revocable selective cross-project dependency grants, no global search,
   encrypted backups and separate memory data retention policy.
6. Browser/UI integration and user-facing accessibility tests only after
   contract and database validation.

Merged source files cannot be called a deployed or live feature.
