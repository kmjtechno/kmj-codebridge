# GitHub Bridge

KMJ CodeBridge can expose GitHub repository and CI operations through the same MCP
endpoint used by ChatGPT, Claude and generic MCP IDE/CLI clients.

The GitHub credential stays on the CodeBridge gateway. It is never returned to the
MCP client, written into IDE configuration, sent to a device agent or included in
tool output.

## Gateway configuration

Use a dedicated least-privilege GitHub App installation token or fine-grained token.
Store it in the gateway service environment, not in `gateway.json`.

Example:

```json
{
  "github": {
    "tokenEnv": "KMJ_CODEBRIDGE_GITHUB_TOKEN",
    "repositories": ["kmjtechno/kmj-codebridge", "kmjtechno/kmj-main-platform"],
    "cacheSeconds": 30
  }
}
```

The gateway process must receive `KMJ_CODEBRIDGE_GITHUB_TOKEN` through a protected
systemd EnvironmentFile, secret manager or equivalent server-side mechanism.

Do not put the token in:

- MCP client configuration,
- project files,
- install URLs,
- shell history,
- CodeBridge tool arguments.

## Current tools

Read scope:

- `github_repository`
- `github_pull_request`
- `github_pull_request_files`
- `github_actions_runs`
- `github_actions_run_jobs`
- `github_actions_job_log`
- `github_pull_request_reviews` (reviews and inline review comments, bounded and redacted)
- `github_commits` (SHA, first message line, author, date)

Write scope:

- `github_create_branch`
- `github_update_file`
- `github_create_pull_request`
- `github_merge_pull_request`
- `github_update_pull_request` (title, body, base, open/closed only; optional `expectedHeadSha` re-reads the pull request right before the change and refuses a moved head or a non-open pull request; closing needs `confirmClose: true`; never merges or approves)
- `github_review_pull_request` (COMMENT or REQUEST_CHANGES only; optional exact head guard; approval stays human)
- `github_reply_review_comment`

Repository access is additionally restricted by the configured repository allowlist.
Read requests are cached briefly to reduce GitHub API traffic. Write operations clear
the cache. File updates require an exact existing blob SHA and branch, so stale writes
fail closed. Pull-request merge requires the exact expected head SHA and refuses to
merge until every bounded GitHub check run for that head is completed successfully.

Actions job logs are bounded and pass through CodeBridge secret redaction before
being returned to the model.

## Hosted identity and permissions

The GitHub bridge is optional and disabled unless configured. Keep repository scope narrow and grant the server-side credential only the GitHub permissions needed by the enabled tools. CodeBridge never accepts a GitHub token as an MCP tool argument.

## Authentication roadmap

The initial bridge deliberately accepts only a server-side credential reference.
A future Main Platform GitHub App/OAuth connection can mint and rotate installation
tokens automatically without changing the MCP tools or client configuration. This
keeps CodeBridge as one product and avoids placing GitHub credentials in every AI
IDE/CLI.

## Credential-free public fallback

For a public repository, hosted deployments may intentionally enable a
credential-free read-only mode. This mode is restricted to the canonical
`https://api.github.com/` origin, requires an explicit repository allowlist,
does not send an Authorization header, and does not expose branch or pull-request
creation tools.

Hosted environment:

```text
CODEBRIDGE_GITHUB_PUBLIC_READ_ONLY=true
CODEBRIDGE_GITHUB_REPOSITORIES=kmjtechno/kmj-codebridge
```

Use the private broker/token mode when private repositories or GitHub writes are
required. Public read-only fallback never grants access to private repositories.

## Development permission recovery

A live doctor result of `read_ready` plus `http_403` is not a write pass. Check the recorded operation against the exact repository grant of the gateway-held credential. For branch and source changes require Contents read/write; for PR creation and merging require Pull requests and Contents read/write; for issue operations require Issues read/write; for CI evidence require Actions and Checks read. Metadata read is required. Workflow-file edits require separately reviewed Workflows write only when needed. Do not enable administration, bypass branch protection, grant all repositories or expose tokens. Preserve exact-head owner review and signed release controls. The protected gateway owner must repair the actual token/installation and exact allowlist; source changes cannot modify those grants. Recheck the doctor and prove a real authorized branch or PR mutation before marking native write recovered.
