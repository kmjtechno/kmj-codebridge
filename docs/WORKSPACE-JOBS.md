# Workspace tool requests (opt-in device consumer)

Implements the device side of the Main Platform contract
`docs/CODEBRIDGE_WORKSPACE_DEVICE_JOBS_CONTRACT.md` (kmj-main-platform PR #704).
Disabled by default. Without `workspaceJobs.enabled` on a project there is no timer,
no request and no background activity.

## Configure (per project, administrator only)

```json
"workspaceJobs": {
  "enabled": true,
  "tools": ["git_status", "inspect_project", "quality_gate"],
  "gates": ["fast"],
  "requireCleanCheckout": true
}
```

- `gates` must be configured gates of the same project; `quality_gate` needs a writable project.
- Requires `license.mode = "signed"` with `renewal`: the existing device bearer credential and
  that endpoint's own origin are the only credential and URL used. No new listener or installer.
- Refuses to start as root.

## What a request can do

Only the three tools above. Arguments are a closed schema (`quality_gate` takes one gate id).
Every claim re-checks: project opted in, tool enabled locally, gate listed AND configured,
license still allows `read`/`execute`, lease sane (clock drift), clean checkout (default).
Anything else is reported `failed` with a short code and nothing runs.

## Safety properties (tested with a real local HTTP fake)

- Claim token is kept in memory and sent only as `X-KMJ-Claim`; credential and token never appear
  in reports, status codes or logs. Reports contain counts, ids and exit codes, never command output.
- `409`, `401/403`, `404`, `422` on any report stop the job; a running gate is cancelled.
- Reports retry with bounded backoff; claim polling backs off after 401/403 (5 min), 503 (1 min+), outages.
- Jobs run through `JobRunner` with key `ws-job:<id>`: a duplicate offer or restart never executes twice.

## Not proven

No live round-trip with kmjtechno.com, no signed canary, no 24x7 claim. Main Platform keeps the
feature off by default (`CODEBRIDGE_WORKSPACE_JOBS_ENABLED=false`).
