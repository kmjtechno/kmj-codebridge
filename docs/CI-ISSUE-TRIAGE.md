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

This is *source implementation*. The gateway version must be deployed and
its protected CircleCI token and output-host allowlist installed before
claiming CircleCI diagnostic MCP functionality is live.

## Pending full autonomy

A resumable isolated fix worker, reviewed patch proposal/apply transaction,
automatic PR draft creation, bounded retries and recovery/soak evidence
remain separate tasks. Never claim 24x7 autonomous repair until the actual
persistent worker, gate evidence, rollback and live logs prove it.
