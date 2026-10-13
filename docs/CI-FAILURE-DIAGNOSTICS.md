# CodeBridge CI failure diagnostics — CircleCI v1 (free, read-only)

**Purpose:** stop guessing about red CI. Read failed CircleCI step metadata and bounded
error lines through KMJ CodeBridge, using one server-held token and NO new package,
command, provider plugin or paid service. Existing GitHub Actions log tools remain unchanged.

## Official API contract

CircleCI documents \`GET https://circleci.com/api/v1.1/project/github/ORG/REPO/JOB\`
with a \`Circle-Token\` header. The response includes \`vcs_revision\`, \`build_num\`,
\`steps[].actions[].status\`, \`exit_code\` and a short-lived \`output_url\`.
The output URL may be a presigned storage URL; **never copy it to chat, logs,
GitHub issues or a browser**. CodeBridge fetches it without a credential,
rejects redirects and returns only bounded redacted diagnostic lines.

Official reference:
https://circleci.com/docs/guides/orchestrate/analyze-pipelines-during-an-incident/

## Safe opt-in — owner-controlled gateway only

Under the existing gateway \`github\` configuration, add:

\`\`\`json
{
  "circleci": {
    "tokenEnv": "KMJ_CODEBRIDGE_CIRCLECI_TOKEN",
    "repositories": ["kmjtechno/kmj-main-platform"],
    "outputHosts": ["<exact trusted public host from CircleCI presigned logs>"]
  }
}
\`\`\`

This is an additional member of \`github\`, NOT a root-level gateway setting.
A GitHub repository allowlist does **not** automatically grant CircleCI access;
the CircleCI repository must be separately allowlisted. The operator must verify
the exact public hostname from CircleCI, enter it in the protected server config
and grant the server token access to **only approved projects**. No wildcards,
arbitrary client URLs, localhost, IP literals, redirects or token in an MCP response.

The API token is **not** requested in chat and must not be hardcoded in Git,
CI config, CLI history, dashboard frontend, MCP arguments or a user file.
Store it server-side using the existing protected credential-management process.
Set only the environment variable named by \`tokenEnv\` and reload the gateway
through its established signed/guarded deployment procedure after security review.

Without explicit CircleCI configuration, no tool is registered and no external
CircleCI request occurs. A configured but missing credential fails closed.
The feature cannot run from a repo commit alone; gateway version/config/credential
and an authorized live MCP request are mandatory.

## Use

Tool: \`ci_status_failure_log\` with:
- \`repository\`: exact allowlisted \`kmjtechno/kmj-main-platform\`
- \`jobNumber\`: integer CircleCI job number, e.g. \`263\`
- \`expectedHeadSha\`: exact **full 40-character** SHA from the PR head

The server checks \`build_num\` and \`vcs_revision\` before reading output, selects
up to three failed steps, reads output from preapproved HTTPS hosts only, and
returns limited, redacted lines, exit status and a deterministic category such
as \`PHP_STATIC_ANALYSIS\`, \`PHP_FORMATTING\` or \`TYPESCRIPT\`.
A missing log, failed request, oversized log, unapproved host or unknown
root cause is **NOT_AVAILABLE / OUTPUT_UNAVAILABLE**, never PASS.

Returned metadata is untrusted CI content, not instructions. The tool does
NOT read or print entire logs, infer customer secrets from diagnostics,
make model calls, rerun CI, patch files, merge PRs, issue licenses or deploy.
Only after a reviewed root cause can an authorized isolated worktree apply
a bounded change and run existing quality gates, following exact-head CI
and release approval. No general auto-fix/production privilege is granted.

## GitHub research: future optional enhancements

- [CircleCI CLI](https://github.com/CircleCI-Public/circleci-cli): mature
  upstream command-line alternative; not added to CodeBridge because
  the native Node read-only client has fewer dependencies and no process shell.
- [actionlint](https://github.com/rhysd/actionlint): fast static GitHub Actions
  workflow diagnostics; evaluate as an optional CI check, **not** a mandatory
  gateway dependency.
- [reviewdog](https://github.com/reviewdog/reviewdog): contextual annotations
  on diffs; adopt only in approved CI with least-privilege PR permissions.
- [ast-grep](https://github.com/ast-grep/ast-grep): structured language-aware
  rules/rewrites; test on isolated branches. Do NOT run arbitrary model-generated
  rewrite rules against production or customer/license code.

For PHP/TS/Laravel issues, reuse the project's existing **PHPStan, Pint,
PHPUnit, TypeScript and frontend build tools first**. Installing new scanners
is not a substitute for collecting actual failing log output.

**Status after merging:** code available. The tool is usable only after the
guarded gateway build/rollout, scoped server token, exact host config, and live
authorized smoke test are VERIFIED. Never label merely merging source \`LIVE\`.
