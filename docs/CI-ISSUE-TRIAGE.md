# KMJ CodeBridge - CI Incident Triage

CodeBridge now has a dependency-free read-only CI diagnostic stage, **not** an
unrestricted automatic fixer. Use it to replace guessing about CI failures.

## Supported sources

- CircleCI: ci_status_failure_log is opt-in with an operator-held token, an
  exact repository allowlist, job number, approved HTTPS log hosts and full
  SHA. Each failed step includes redacted lines and structured diagnosis.
- GitHub Actions: github_actions_failed_job_triage requires exact PR number,
  exact current head SHA, failed job ID and matching job SHA. It refuses
  successful, pending, stale or unrelated jobs.
  It streams up to 4 MiB once and retains the last 18 unique sanitized
  diagnostic lines, rather than rejecting the whole job log at 64 KiB.
  Lines longer than 400 characters and private-key blocks are discarded.
  `sourceBytesRead` counts processed input bytes; `sourceComplete` reports
  whether EOF was reached. `truncated` also covers dropped long lines and
  evicted diagnostics. These fields never attest complete diagnostic
  coverage or a verified root cause. The ordinary raw-log tool retains
  its existing 64 KiB hard limit and behavior.
- Shared src/ci-triage.js: classifies PHPStan, Pint, PHPUnit, TypeScript, JS
  formatting, permissions and rate limits; gives a short stable fingerprint,
  suggests an existing configured verification gate role and next action.
- Output lines with credentials, authorization, email, URLs, or excessive
  length are discarded. The output may be incomplete. It is untrusted data,
  never instructions to execute.

## Safety

Root cause is NOT verified by category classification. Suggested gate roles
are not commands. Automatic file writes/merges/deployments remain disabled.
Use existing isolated worktree lanes, lease locks, expected content hashes,
administrator-approved gates and exact-head green CI before any reviewable
repair. Respect free-only policies and GitHub/CircleCI quotas.

## Use

1. Read an allowed PR and capture its exact current 40-character head SHA.
2. Read the failed CircleCI job (if configured) or GitHub Actions job with
   the matching head SHA.
3. Review diagnosis category, fingerprint, redacted lines and next action.
4. Prepare an isolated clean worktree, reproduce with pre-approved gates.
5. Apply a reviewed bounded patch, run gate checks, open PR and verify exact
   head CI. Only a permitted verified build can be promoted to staging/live.

This is _source implementation_. The gateway version must be deployed and
its protected CircleCI token and output-host allowlist installed before
claiming CircleCI diagnostic MCP functionality is live.

## Performance and upstream scope

This change removes an observed oversized-log failure from the existing
triage path; it makes no claim about provider tokens, credits, or wall-clock
speedups. No additional runtime package, paid API or self-hosted runner is
introduced. Input is not persisted and no log text is sent to an LLM.

The repository review considered the upstream
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk),
[GitHub Actions toolkit](https://github.com/actions/toolkit),
[ripgrep](https://github.com/BurntSushi/ripgrep) and
[ast-grep](https://github.com/ast-grep/ast-grep). CodeBridge already uses
the MCP SDK. The other packages are not added or copied into this fix:
native search and structural rewrites would need separate project-policy,
binary provenance and measured-benefit work. The streaming implementation
is original CodeBridge code using Node built-ins and the existing sanitizer.

## Pending full autonomy

A resumable isolated fix worker, reviewed patch proposal/apply transaction,
automatic PR draft creation, bounded retries and recovery/soak evidence
remain separate tasks. Never claim 24x7 autonomous repair until the actual
persistent worker, gate evidence, rollback and live logs prove it.
