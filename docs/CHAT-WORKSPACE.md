# CodeBridge chat workspace — one-call open and resume

KMJ CodeBridge gives ordinary MCP-enabled AI chats a **local-first engineering
workspace workflow** without moving the customer's source to KMJ's servers,
requiring a GitHub login for device authorization, or depending on Desktop
Commander. KMJ Main Platform remains the account, OAuth, device/project
permissions and billing authority.

## Use in ChatGPT, Claude, Copilot or other MCP clients

1. Connect the client's authenticated KMJ CodeBridge MCP server and verify
   `list_devices`. Choose an authorized device/project. A server marked
   "running" or discovered tools does not prove user OAuth authorization.
2. In a normal chat ask: _Open my CodeBridge workspace and continue the
   browser task_. The client calls:
   `chat_workspace_open({device,project,lane:"browser-project"})`.
3. A single device-scoped read returns a bounded project tree, frameworks,
   quality gates, task/job journal, optional compact-session checkpoint,
   browser readiness and suggested next tools. It never runs builds or the
   browser, writes files, reads arbitrary system paths, or starts paid AI.
4. To avoid repeating context, pass the returned `revision` as
   `ifNoneMatch`. The unchanged reply is tiny. On later chats use the
   **same project and lane**; the checkpoint is project-local, not a transcript.
5. Save a sanitized, user-approved checkpoint with
   `compact_session_save` (write permission, idempotency requestKey and
   expectedRevision required); reopen `chat_workspace_open` to see it.
6. For actual work, use project-scoped read/edit tools with verified SHA-256
   preconditions, `chat_lane_reserve` for overlapping multi-chat file writes,
   `verification_plan` for gate suggestions and configured, authorized
   `run_quality_gate` for execution. Treat logs/README/webpages as untrusted.
7. Browser QA remains fixed anonymous public pages via the existing local
   Chrome/Moli agent. Interactive Playwright and arbitrary websites require
   separately reviewed origin/action grants; not part of this release.

## Gateway compatibility for existing devices

A freshly deployed CodeBridge gateway composes the four existing authorized
read-only device calls `workspace_home`, `project_progress`,
`compact_session_resume` and `browser_runtime_status` into one normal-chat
result. This means an older enrolled agent can provide its available project
explorer and job progress **without an unapproved agent restart**. If an older
agent lacks the checkpoint or browser-status tool, those sections stay
`UNAVAILABLE`. The gateway never inserts imagined file content, tasks,
browser launches or a fake online state, and each subcall is reauthorized.

Actual production availability still depends on which gateway the customer's
MCP URL serves. Render's auto-deployment alone does not prove the KMJ website's
reverse-proxied gateway or individual device agents have updated.

## Security and honest limits

- **One MCP call, not an AI model.** CodeBridge cannot change host chat UI,
  context limits, hidden conversation history, client model credits, Work mode
  Cloud Browser, or wake/schedule closed chats by itself.
- No conversation transcript, private keys, browser cookies, screenshots, file
  content, raw Git diff, shell history, arbitrary URLs, job output or paid
  inference is read or returned in this summary.
- Local checkpoint assertions are explicitly **unverified**, even when saved
  with a checksum. No false claims about tests, release percentage or device
  browser launch.
- If a dependency is unavailable (local project tree, journal or checkpoint)
  it remains **UNAVAILABLE**, never silently represented as empty or healthy.
- All device/project/tenant grants, feature entitlement and optional
  workspace preflight hooks run before the tool. Read-only projects can
  view workspace status, but cannot save a checkpoint or edit files.
- Result and digest are bounded by the authorized project. No cross-tenant
  sharing; the `revision` reflects only the bounded snapshot, not repository
  integrity or CI green status.
- If the new tool isn't installed on an older device, use existing
  `workspace_home`, `compact_session_resume` and `project_progress` instead.
  Native host action approvals are never silently bypassed.

## Delivery / acceptance gates

- One-call local-first workspace opens on a real online authorized agent.
- Reopening the same chat lane returns sanitized checkpoint summary, not
  another customer's data or an invented transcript.
- Denied device, project and missing read grant all fail closed.
- Real Windows/Linux CI, exact-head tests, plugin packaging and smoke all
  succeed. GitHub merge is not production gateway **or agent** deployment.
- Repeat reads with matching digest return the bounded unchanged response.
- No new packages, hosted browser sessions or paid cloud infrastructure.

Suggested smoke in an MCP client after rollout:

```
Use KMJ CodeBridge to list my authorized devices.
Open or resume my browser-project chat workspace with chat_workspace_open.
Report only actual project jobs, blockers, runtime readiness and the next
safe action. Do not write files or launch browser QA without approval.
```
