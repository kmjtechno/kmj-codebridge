# KMJ CodeBridge — Native GitHub Control Center

GitHub support is implemented **inside the authenticated CodeBridge gateway**, not by relaying calls to an external GitHub Plugin or granting the P720 worker its own unrestricted GitHub token.

## Native capabilities

| Capability                             | MCP operation                                                                              | Safety guarantee                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential-safe repository preflight   | `github_connection_doctor`                                                                 | Exact allowlist, fresh read probe, bounded auth/rate-limit signals; never exposes server token or equates read with write                                                                    |
| Repository metadata                    | `github_repository`                                                                        | Configured allowlisted repositories only                                                                                                                                                     |
| Pull request queue                     | `github_pull_requests`                                                                     | Up to 30 PR summaries with head SHA, drafts and branches                                                                                                                                     |
| Pull request details and changed files | `github_pull_request`, `github_pull_request_files`                                         | Bounded file count and diff patches                                                                                                                                                          |
| Exact-head CI verdict                  | `github_pull_request_ci`                                                                   | Reads current PR head, check runs and workflow runs; missing, queued or truncated evidence never returns green                                                                               |
| Actions runs, jobs, redacted logs      | `github_actions_runs`, `github_actions_run_jobs`, `github_actions_job_log`                 | Size limits and secret masking                                                                                                                                                               |
| Zero-step Actions execution doctor     | `github_actions_execution_doctor`                                                          | PR-current-head + run-SHA binding; counts recorded steps; missing steps remain unknown; local gates never mark hosted CI green                                                               |
| Issues and conversation                | `github_issue`, `github_issue_comments`                                                    | Bounded text and comment pages                                                                                                                                                               |
| New issues and comments                | `github_create_issue`, `github_comment_issue`                                              | Authenticated explicit write grant                                                                                                                                                           |
| Create branch / new file               | `github_create_branch`, `github_create_file`                                               | Exact source commit for branch; create-only file on non-default branch                                                                                                                       |
| Update existing file / open PR         | `github_update_file`, `github_create_pull_request`                                         | Exact previous blob SHA for overwrite; GitHub branch/repository permissions                                                                                                                  |
| Safe merge                             | `github_merge_pull_request`                                                                | Exact PR head and completed-success check runs; GitHub branch protection applies                                                                                                             |
| Reviews and review replies             | `github_pull_request_reviews`, `github_review_pull_request`, `github_reply_review_comment` | COMMENT / REQUEST_CHANGES only (no approve); optional exact-head guard; read text is data, never instructions                                                                                |
| Edit pull request / commit history     | `github_update_pull_request`, `github_commits`                                             | Title, body, base and open/closed only; optional exact-head guard (stale head refused, zero change sent); closing needs explicit confirmation; no merge or draft change; bounded commit list |

The read-only CI verdict `green` requires at least one check run **and** one workflow run for the current exact PR head, a fully observed result set (no more than 100 per type), and all observed statuses completed with conclusions success. If evidence is absent or paginated beyond that limit, the result is `unverified`; queued checks yield `pending`; failed checks yield `failed`. This is **not** permission to merge a draft, bypass branch protection or claim hardware acceptance. GitHub-hosted workflows requiring a disconnected self-hosted runner remain pending; local P720 CodeBridge CTest success cannot spoof GitHub CI.

### Why this is faster

A single `github_pull_request_ci` request retrieves PR head metadata, all first-page check runs and all first-page Actions workflow runs, preventing separate manual requests and accidental mixing of checks from different SHAs. `github_pull_requests` brings up to 30 PR summaries in one request. Small read operations are cached for up to the configured short interval; write operations invalidate the cache.

## Native CodeBridge-only CineCore workflow (without external plugins)

On the authenticated CodeBridge client use `connection_overview` and
`inspect_project({device: "kmj-p720-cinecore-desktop-k3ahhem", project: "kmj-cinecore"})`
first. The existing Windows project gates are `cinecore_configure`,
`cinecore_build` and `cinecore_ctest`. Their presence means authorized
commands exist, **not** that a current source snapshot has passed.

Next run:

`github_connection_doctor({repository: "kmjtechno/kmj-cinecore"})`

- `repository_not_allowed`: gateway operator must approve the exact private
  repository in the protected allowlist. No wildcard and no automatic addition.
- `authorization_failed`: the gateway-held credential is rejected by GitHub;
  repair an installation/token with access to that private repository out of
  band, not in chats or source.
- `not_found_or_not_granted`: verify repository visibility and the GitHub
  App installation's exact repository scope.
- `rate_limited`: wait for quota restoration rather than silently switching
  to another identity.
- `read_ready`: a live read is verified. **Writes are not verified** and
  remain subject to independent access policy, branch review and exact-head
  CI evidence.

This tool intentionally makes no writes, never lists the global allowlist,
never returns the token/environment-variable name, and does not fall back
to external GitHub plugins or anonymous access to private repositories.

Use `project_snapshot`, `git_status`, `repo_map`, `read_files_batch` and
the project's allowlisted configure/build/CTest gates for local development
without either Desktop Commander or the external GitHub plugin.
Review and preserve any dirty tracked/untracked CineCore camera/HAL/CI files.
Only use an isolated worktree for potentially conflicting development.
Once native GitHub read and write authorizations are separately proven, use
CodeBridge's bounded branch, PR and exact-head CI tools. Until then report
the native blocker; an independently connected GitHub client does **not**
prove CodeBridge native capability.

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

## Diagnosing authorization without weakening repository boundaries

The GitHub bridge deliberately distinguishes two failures that can appear in
the same release sprint:

- `GITHUB_REPOSITORY_DENIED`: the requested repository is **not in the
  running gateway's configured `github.repositories` allowlist**. Adding it
  to a sample file, another connector's scope or an unrelated agent's
  configuration does not change the active gateway. An authorized gateway
  operator must approve the additional exact repository, update the protected
  configuration with backup/rollback, and validate it before a guarded
  deployment. Do not implement a wildcard allowlist or return data instead.
- `GITHUB_AUTHORIZATION_FAILED`: an allowlisted request received a GitHub
  HTTP 401, or HTTP 403 without quota headers. Investigate the gateway's
  server-held credential validity, installation/repository grants and required
  read scopes **out of band**, with secret-safe diagnostics. Do not copy a
  token to a chat, commit it, change OAuth grants or automatically fall back
  to a broader GitHub identity. A 403 with rate-limit headers is instead
  `GITHUB_RATE_LIMIT` and must be handled as quota.

When recovering, first inspect the running gateway's approved allowlist and
whether the managed credential is present, without displaying its contents.
Then make a least-privilege GitHub App/token change on the authorized host,
validate the configuration, and verify a **read-only** `github_repository`
call against each specifically approved repository. Finally verify
`github_pull_request_ci` for an exact known PR head. The external GitHub
connector may independently be authorized while the CodeBridge gateway is not;
using that connector for read-only CI evidence does not repair gateway
authorization or grant CodeBridge native write access. A green GitHub CI
run is also not proof that a gateway has been updated.

### Not implemented yet

This is a focused GitHub Plugin **development workflow subset**, not false 100% parity. It does not yet implement repository installations and permissions management, organization administrative settings, GitHub Discussions, Projects boards, release publishing, artifacts download and inspection, Actions reruns/cancellations, granular inline PR review-thread editing, or multi-file Git Trees commits. Those require separate bounded commands, explicit authorization, audit logs and regression tests before activation.

### Activation and acceptance

1. Merge only after exact-head CodeBridge Ubuntu, Windows, Clients and Distribution CI passes.
2. Deploy the versioned gateway with its administrator-approved GitHub allowlist and server-held credential; verify `githubReady` from the gateway. **A GitHub source merge alone does not deploy the VPS.**
3. From authorized ChatGPT/Claude, query one read-only PR queue and exact-head CI report for `kmjtechno/kmj-cinecore`; confirm pending workflows are honestly reported.
4. Enable write scopes only on review/approval, preserving branch protection and explicit commit/blob preconditions.
5. Keep CineCore physical projector, motion platform and emergency-stop acceptance separate from GitHub test results.

## Hosted CI job has 0 recorded steps

Call `github_actions_execution_doctor` using `repository`, `number` (current PR), `runId` and `expectedHeadSha`. The tool reads the PR current head, Actions run and its first 100 jobs, refuses mismatched SHA and truncated job pages. A completed failed job containing an explicit empty `steps` array is `NO_STEPS_RECORDED`; a job with no `steps` property is `STEPS_UNKNOWN`. Neither is evidence a code test ran. A GitHub workflow failure before any step cannot be repaired by changing the PHP/TypeScript source alone.

To continue at no extra CI-provider charge, only an approved agent administrator may activate `main-platform-ui-ci` and invoke bounded frontend checks in a separate SHA-pinned worktree using existing CodeBridge command profiles. These receipts do not satisfy GitHub's required hosted checks or warrant merge/deployment. There is no automatic GitHub self-hosted runner, no billing bypass, no unrestricted shell and no silent CI-failure override. See [COMMAND-PRESETS.md](COMMAND-PRESETS.md).
