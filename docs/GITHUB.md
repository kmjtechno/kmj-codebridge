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
    "repositories": [
      "kmjtechno/kmj-codebridge",
      "kmjtechno/kmj-main-platform"
    ],
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

Write scope:
- `github_create_branch`
- `github_create_pull_request`

Repository access is additionally restricted by the configured repository allowlist.
Read requests are cached briefly to reduce GitHub API traffic. Write operations clear
the cache.

Actions job logs are bounded and pass through CodeBridge secret redaction before
being returned to the model.

## Authentication roadmap

The initial bridge deliberately accepts only a server-side credential reference.
A future Main Platform GitHub App/OAuth connection can mint and rotate installation
tokens automatically without changing the MCP tools or client configuration. This
keeps CodeBridge as one product and avoids placing GitHub credentials in every AI
IDE/CLI.
