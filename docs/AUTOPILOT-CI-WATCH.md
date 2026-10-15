# KMJ CodeBridge — 24×7 GitHub CI Watch → Safe Repair Queue

This is an **opt-in, continuous running-agent watcher** for authorized,
deterministic formatting/repair recipes, not a general autonomous patch
publisher or privileged production deployment system. It relies only on
existing Node, GitHub REST, the durable Autopilot journal, and the isolated
repair worker. No new npm package, paid model, paid hosting or CLI plugin.

## What it actually does

Once a device agent is installed, authorized and running:

1. On the approved local Git branch, read the current exact HEAD SHA without
   changing the repository or overwriting Claude's uncommitted files.
2. At most once every configured 10–60 minutes, query GitHub Actions runs for
   that SHA using the official REST API. Never poll on every agent heartbeat.
3. Check that the **newest matching** workflow run is a completed failed
   `push` run for that exact SHA, branch and workflow name. Pending/success
   runs, a stale SHA, a PR merge ref or truncated API pages fail closed.
4. Read only structured **job metadata**, not raw logs or secrets. Queue the
   explicitly approved `auto-repair:RECIPE:SHA` task **only** when the named
   job itself is a completed failure with the same SHA.
5. The existing isolated worker then runs only its preapproved fixing gate
   and its independent verification gate, checks allowed tracked files and
   bounded diff, and pauses at **VERIFIED_PATCH_AWAITING_REVIEW**. This stage
   does not push commits, publish a PR, merge, pay for inference, or deploy.

The journal's unique task key remains durable across agent restarts.
Repeated failed CI observations cannot create unlimited duplicate tasks.

## Example project config (protected agent config JSON)

This is an example of the nested `projects[]` entries. The named gates
must already be administrator-approved and non-destructive:

```json
{
  "id": "kmj-codebridge",
  "root": "/srv/kmj-codebridge-projects/kmj-codebridge",
  "writable": true,
  "gates": {
    "format_src": {
      "command": "node",
      "args": ["scripts/safe-local-formatter.js"]
    },
    "fast_check": {
      "command": "npm",
      "args": ["run", "check"]
    }
  },
  "autopilotRepairWorker": {
    "enabled": true,
    "recipes": {
      "format": {
        "fixGate": "format_src",
        "verifyGate": "fast_check",
        "paths": ["src/", "tests/"]
      }
    }
  },
  "autopilotCiWatch": {
    "enabled": true,
    "repository": "kmjtechno/kmj-codebridge",
    "branch": "main",
    "workflow": "CodeBridge CI",
    "job": "verify (ubuntu-24.04)",
    "recipe": "format",
    "publicReadOnly": true,
    "intervalSeconds": 900
  }
}
```

**Important:** This is a shape example, not proof those scripts or gates
exist on the production machine. Never enable before checking the exact
gate argv and its allowed file scope, root ownership, clean install and
rollback. Git worktrees are **not** an OS-level security sandbox. Only
trusted administrator-owned deterministic fixing commands are eligible.

For a **private** repository, remove `publicReadOnly` and instead configure
`"tokenEnv": "KMJ_CODEBRIDGE_GITHUB_CI_READ_TOKEN"` in the protected agent
environment. The credential must be restricted to approved repository
Actions metadata read access. Never paste it into a chat, PR, dashboard,
artifact, tracked file or shell history. Public read-only mode uses **no
token** and is subject to the GitHub unauthenticated API rate limit.

## Why the fail-closed checks matter

- Watching a PR often involves a _synthetic merge SHA_, not the PR's own
  exact head. This version intentionally supports only a matching
  `push` event on a locally checked-out named branch. It does not treat
  arbitrary PR failures as authorized repair tasks.
- GitHub failures can be tests, runner capacity, dependencies or formatting;
  **a failed job is not a proven root cause**. Only an operator-curated
  deterministic repair recipe may run, and no-op or unsafe fixes wait for
  review. The diagnostic readers remain separate.
- Automatic PR publication/review/merge, external GitHub webhook ingestion,
  AI-generated code edits and production promotion are **not implemented by
  this watcher**.
- CI polling is throttled before HTTP, including missing credentials and
  401/429/5xx. No unbounded retry or quota bypass.
- Agent restart recovery preserves the durable repair-task checkpoint;
  a potentially mutating prior command cannot be silently re-run.
- No background job exists unless all of `writable`,
  `autopilotRepairWorker.enabled` and `autopilotCiWatch.enabled` are true
  with a configured known recipe.

## Release acceptance

Full functionality requires a live updated agent on a trusted machine,
real Git and project checkout, configured approved gates, a free-capacity
GitHub API path, actual CI failure smoke test, authorized license, service
auto-start and observed restart/soak evidence. The source-only GitHub PR
cannot establish those live conditions; do not label a merged PR **24×7
production live** by itself.
