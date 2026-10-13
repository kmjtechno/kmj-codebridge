# KMJ CodeBridge — Local Autopilot Draft Worker

This is a **default-off**, on-device, low-cost autonomous *drafting* slice.
It uses the existing installed loopback Ollama model and Autopilot journal.
It neither completes coding tasks nor edits source or performs deployment.

## What works

- An administrator may opt into an exact installed model, output token
  cap and inference timeout in a writable project's agent configuration.
- Only explicit tasks whose keys begin `auto-draft:` are processed.
  The enqueue caller needs `write` and `execute` permissions.
- The worker does not execute README or model-produced commands and does not
  send the prompt to a cloud API.
- It uses the same local-model client as CodeBridge's existing MCP local
  tools so one process cannot unknowingly run parallel inference via separate
  local client locks.
- Offline/missing local models keep tasks queued until available. There is no
  automatic model download and no unexpected paid/cloud inference.
- Generated text is an untrusted proposal stored as a bounded durable
  Autopilot checkpoint. The task goes to `waiting`, never `succeeded`.
- Inference errors do not trigger infinite retries; an explicit resume and
  review are needed. Already stored draft checkpoints are never overwritten
  by re-inference after a restart.

## Opt-in example

In an administrator-controlled agent config, on an already-writable approved
project:

```json
{
  "autopilotLocalWorker": {
    "enabled": true,
    "model": "qwen3:4b",
    "maxTokens": 128,
    "timeoutSeconds": 30
  }
}
```

Keep `enabled` absent or false on production until a separately isolated
worker, enrolled device, installed model, update/rollback plan and actual
inference/soak checks are verified.

Queue with existing authorized `autopilot_enqueue` (write+execute scope):

- `key: "auto-draft:feature-a"`
- `objective: "Implement and test ..."`
- `project: <authorized project>`

Observe `autopilot_status` after the worker starts. A successful draft
shows `waiting` + `LOCAL_DRAFT_AWAITING_REVIEW` and a checkpoint with
`next: LOCAL_DRAFT_AWAITING_REVIEW`. This is evidence of a *proposal*,
**not a verified implementation**.

## Remaining work before end-to-end autonomous development

- Model/provider routing and secure credentials with quotas, tenant approvals
  and context handoff (no paid fallback).
- Structured, validated patches in separate worktrees and file locks.
- Automatic fixed-gate verification, PR creation, exact SHA CI and auditable
  merge integration; no unrestricted shell or force push.
- Recovery/soak tests, code provenance, consent flows and actual hardware
  test matrix for Windows, Linux, macOS.
- Human approval for billing, secrets, destructive production and public
  releases, and waiting when no free approved model is available.
