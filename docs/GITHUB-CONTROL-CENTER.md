# KMJ CodeBridge — Native GitHub Control Center

GitHub support is implemented **inside the authenticated CodeBridge gateway**, not by relaying calls to an external GitHub Plugin or granting the P720 worker its own unrestricted GitHub token.

## Native capabilities

| Capability | MCP operation | Safety guarantee |
| --- | --- | --- |
| Repository metadata | `github_repository` | Configured allowlisted repositories only |
| Pull request queue | `github_pull_requests` | Up to 30 PR summaries with head SHA, drafts and branches |
| Pull request details and changed files | `github_pull_request`, `github_pull_request_files` | Bounded file count and diff patches |
| Exact-head CI verdict | `github_pull_request_ci` | Reads current PR head, check runs and workflow runs; missing, queued or truncated evidence never returns green |
| Actions runs, jobs, redacted logs | `github_actions_runs`, `github_actions_run_jobs`, `github_actions_job_log` | Size limits and secret masking |
| Issues and conversation | `github_issue`, `github_issue_comments` | Bounded text and comment pages |
| New issues and comments | `github_create_issue`, `github_comment_issue` | Authenticated explicit write grant |
| Create branch / new file | `github_create_branch`, `github_create_file` | Exact source commit for branch; create-only file on non-default branch |
| Update existing file / open PR | `github_update_file`, `github_create_pull_request` | Exact previous blob SHA for overwrite; GitHub branch/repository permissions |
| Safe merge | `github_merge_pull_request` | Exact PR head and completed-success check runs; GitHub branch protection applies |

The read-only CI verdict `green` requires at least one check run **and** one workflow run for the current exact PR head, a fully observed result set (no more than 100 per type), and all observed statuses completed with conclusions success. If evidence is absent or paginated beyond that limit, the result is `unverified`; queued checks yield `pending`; failed checks yield `failed`. This is **not** permission to merge a draft, bypass branch protection or claim hardware acceptance. GitHub-hosted workflows requiring a disconnected self-hosted runner remain pending; local P720 CodeBridge CTest success cannot spoof GitHub CI.

### Why this is faster

A single `github_pull_request_ci` request retrieves PR head metadata, all first-page check runs and all first-page Actions workflow runs, preventing separate manual requests and accidental mixing of checks from different SHAs. `github_pull_requests` brings up to 30 PR summaries in one request. Small read operations are cached for up to the configured short interval; write operations invalidate the cache.

## Configuring the gateway safely

This feature is **gateway-side**; it does not require a second GitHub Plugin. Only the KMJ authorized VPS/operator should configure it. The example is illustrative and **not** evidence that the production gateway currently has this setting enabled:

```json
{
  "github": {
    "apiBase": "https://api.github.com/",
    "tokenEnv": "KMJ_CODEBRIDGE_GITHUB_TOKEN",
    "repositories": ["kmjtechno/kmj-codebridge", "kmjtechno/kmj-cinecore"],
    "cacheSeconds": 30
  }
}
```

The token exists only in the protected **gateway process environment**, not agent configuration, GitHub source, Claude config or MCP output. Create/choose a GitHub App installation or a minimum-permission token with access to exactly the approved repositories and necessary contents, issues, PR and Actions scopes. Do not paste the token into a chat. User-facing OAuth + Main Platform device/project grants **do not automatically confer GitHub repository write permission**. The configured service credential and the CodeBridge gateway's authenticated tool access policy both apply.

For public repositories without any GitHub credential, the gateway can instead use `publicReadOnly: true` and exactly `https://api.github.com/`. This disables and hides GitHub write tool definitions. A private repository cannot be read through anonymous public mode.

### Not implemented yet

This is a focused GitHub Plugin **development workflow subset**, not false 100% parity. It does not yet implement repository installations and permissions management, organization administrative settings, GitHub Discussions, Projects boards, release publishing, artifacts download and inspection, Actions reruns/cancellations, granular inline PR review-thread editing, or multi-file Git Trees commits. Those require separate bounded commands, explicit authorization, audit logs and regression tests before activation.

### Activation and acceptance

1. Merge only after exact-head CodeBridge Ubuntu, Windows, Clients and Distribution CI passes.
2. Deploy the versioned gateway with its administrator-approved GitHub allowlist and server-held credential; verify `githubReady` from the gateway. **A GitHub source merge alone does not deploy the VPS.**
3. From authorized ChatGPT/Claude, query one read-only PR queue and exact-head CI report for `kmjtechno/kmj-cinecore`; confirm pending workflows are honestly reported.
4. Enable write scopes only on review/approval, preserving branch protection and explicit commit/blob preconditions.
5. Keep CineCore physical projector, motion platform and emergency-stop acceptance separate from GitHub test results.
