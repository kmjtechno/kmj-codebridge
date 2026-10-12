# Local LLM-first engineering with KMJ CodeBridge

CodeBridge connects an authorized MCP client to a project-scoped device agent.
Its built-in local-model operations are **local-only**, not a broker that
silently chooses a paid hosted model. Start with already installed Ollama
models, then use verified edits, scoped quality gates and GitHub review
to turn an AI proposal into trusted engineering work.

[Back to README](../README.md#local-llm-first) ·
[Client setup](CLIENTS.md) ·
[Security](../SECURITY.md) ·
[Release status](STATUS.md)

## What "local first" means

- **Compute:** `local_model_status`, `local_model_generate` and
  `autopilot_local_draft` use the authorized device's own loopback Ollama
  service. The agent never contacts arbitrary public inference URLs.
- **No surprise billing:** Missing/failed local models terminate with bounded
  errors. These local tools do **not** call OpenRouter, cloud LLMs or paid
  providers, and never trigger model downloads.
- **Client distinction:** ChatGPT, Claude and other hosted MCP clients still
  have their **own** inference/privacy/billing behavior. CodeBridge's
  local-only guarantee does not make those clients offline.
- **Trust:** Model text is untrusted. A draft is not applied code, a passing
  test, a secure patch or a production deployment.
- **Device controls:** The agent is outbound-only and limited to approved
  project paths. An MCP caller cannot choose arbitrary localhost ports,
  bypass local-processing approval or receive a generic root shell.

## Quick start on an existing approved device

1. Ensure the existing CodeBridge agent is **connected**, the desired
   project is authorized, and Ollama is already running **on that device**.
   Do not install/download extra models merely to complete a smoke test.
2. In ChatGPT, Claude Code or another authenticated MCP client, select the
   existing KMJ CodeBridge connection. Call `connection_doctor` and
   `local_model_status` for your specific `device` and `project`.
   The latter requires read access and returns installed model names.
3. If the client doesn't expose `local_model_status`, compare its fresh
   MCP `tools/list` against `https://kmjtechno.com/mcp`, refresh the
   **existing** app's tool capture and re-check OAuth grants. A public tool
   listing alone cannot prove that a protected `tools/call` is authorized.
   Do not create a second app, share device secrets or bypass authentication.
4. Use an **installed** model with a short prompt. Example arguments for a
   tool invocation (use your own authorized device and project):

   ```json
   {
     "device": "kmj-p720-desktop-k3ahhem",
     "project": "kmj-codebridge",
     "model": "qwen3:4b",
     "prompt": "List three bounded tests for a path-safe file editor.",
     "maxTokens": 96,
     "timeoutSeconds": 60,
     "localProcessingApproved": true
   }
   ```

   The example is a **local_model_generate** argument object, not a URL,
   terminal command, credential or public no-auth request. The client must
   have an execute grant. Review the output before using it.

5. Run the already configured `run_quality_gate`, test/secret scan and
   exact-head GitHub CI as applicable. Write to an **isolated feature
   worktree** with hash/HEAD preconditions; never modify an active
   collaborator's dirty `main` checkout.

### Optional read-only Ollama inspection on Windows P720

Use these only in an **existing** P720 PowerShell session. They do not
install models or change services:

```powershell
(Invoke-RestMethod -Uri 'http://127.0.0.1:11435/api/tags').models.name
(Invoke-RestMethod -Uri 'http://127.0.0.1:11436/api/tags').models.name
```

For the measured KMJ P720 setup, port `11435` hosted
`qwen2.5-coder:7b` and `11436` hosted `qwen3:4b`. Port `11434` is
the standard Ollama port. The agent's locally configured allowed ports are
bounded; an ordinary MCP request cannot redirect execution elsewhere.
Other computers may have different installed models.

## Safe model selection

| Model family     | When to consider it                               | Guardrails                                      |
| ---------------- | ------------------------------------------------- | ----------------------------------------------- |
| Qwen3 4B         | Short prompts, fast proposals, low-resource tasks | Explicit installed-model check; review response |
| Qwen2.5-Coder 7B | Coding-oriented bounded drafting when ready       | Check cold-load latency before larger outputs   |
| Qwen3 8B         | Only when already installed and benchmarked       | Higher memory pressure; no automatic pull       |

The system does **not** claim to route tasks automatically to an objectively
best model. Choose on actual task-quality, VRAM/RAM and latency measurements.

A fresh **readiness-only** test on KMJ's Lenovo P720 produced:

| Observation                 |    Qwen2.5-Coder 7B |            Qwen3 4B |
| --------------------------- | ------------------: | ------------------: |
| Generated tokens            |                  48 |                  48 |
| Measured generation         |      33.57 tokens/s |      53.01 tokens/s |
| Ollama-reported GPU offload | 4,621,179,288 bytes | 2,874,062,929 bytes |

These are limited hardware observations, **not** cold-versus-warm
measurements, coding accuracy results or a warranty of performance. The
offload counter does not identify a physical GPU. A previous 7B Autopilot
call hit an 80-second timeout; the root cause is not yet confirmed.

## Resource and security budget

Source-defined local generation limits:

| Setting                   | Current accepted range                | Default or behavior                            |
| ------------------------- | ------------------------------------- | ---------------------------------------------- |
| Prompt length             | 1–4,096 characters                    | Caller must provide a prompt                   |
| Output budget             | 16–512 predicted tokens               | 192                                            |
| Request timeout           | 5–90 seconds                          | 45 seconds                                     |
| Parallel local generation | One in-flight request                 | `LOCAL_MODEL_BUSY` for competing requests      |
| Local retention           | 0–60 seconds                          | `keep_alive: 0` (model unload requested)       |
| Network target            | Configured loopback Ollama ports only | No DNS, remote inference, proxies or redirects |
| Missing model             | Fail closed                           | No model pull and no paid fallback             |

Only the device owner can opt into warm retention using
`CODEBRIDGE_LOCAL_MODEL_WARM_SECONDS` (integer 0–60). It is **not**
something a chat should modify behind the owner's back. Longer warm
retention can reduce model reloads, but consumes idle VRAM; keep the default
until cold/warm gains have been measured on the actual workstation.

For short Qwen3 drafts, the local generator sends `think: false` so the
bounded output allowance is not consumed only by hidden reasoning. The
prompt is not silently rewritten. Missing/busy/timed-out inference is
reported as failure, not disguised as a successful response.

## Claude + ChatGPT parallel engineering lanes

Use an existing authorized Claude Code or Claude Desktop connection for
one **non-overlapping** workstream, and CodeBridge-connected ChatGPT for
another. No client receives implicit ownership of the other's files.

1. **Claude lane:** diagnose local-model load and 7B timeout, verify
   authenticated `local_model_generate`, claim a genuine server-issued
   Autopilot lease and produce a _review-only_ draft. Keep existing
   Claude-owned files reserved.
2. **ChatGPT lane:** own independent documentation, CI/test analysis,
   production acceptance and non-conflicting issue/PR changes.
3. **Handoff:** record exact file ownership, task ID, SHA, tests and
   blockers in [CodeBridge engineering coordination #295](https://github.com/kmjtechno/kmj-codebridge/issues/295).
4. **Never:** reset/stash/clean a dirty collaborator checkout, fabricate
   a lease token, write a draft straight into production, bypass OAuth or
   run unrestricted shell commands.

For `autopilot_local_draft`, first enqueue/claim through authorized
server-issued task operations, then use the returned ID and lease token
with `localProcessingApproved: true`, an already installed model and
a bounded token budget. Its result is a persisted **review-only
checkpoint**; additional operations must respect lease fencing and
checkpoint replay protection. Actual reviewed file edits, configured
tests and safe PR approval are distinct steps.

A completed local draft does **not** prove fully autonomous issue-to-code-
to-PR-to-merge execution. A separate Claude process/session must be
running for ongoing Claude work; an issue comment is coordination, not
a background Claude worker.

## Production acceptance matrix

Treat each layer independently. Do not call the whole product
"100% production-ready" until all required live acceptance gates pass.

| Layer               | Evidence to require                                          | Latest verified scope (13 Oct 2026)               |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| Repository CI       | Exact-head Linux/Windows, clients, distribution              | PASS on recorded main SHA                         |
| Hosted discovery    | Real customer and Render MCP `tools/list` parity             | PASS: 101/101 tools                               |
| Public auth         | Valid OAuth metadata, denial without valid grant             | PASS in hosted smoke                              |
| P720 inference      | Authorized local generation from installed models            | PASS for 7B and 4B, readiness only                |
| Local QA            | P720 bounded unit suite and tracked secret scan              | PASS: 6/6 tests; 287 files scanned                |
| Client catalog      | Fresh same-app tool capture and authenticated call           | NOT VERIFIED in a stale 88-action ChatGPT session |
| Native GitHub write | First-party branch/edit/PR/CI/merge, scoped token            | NOT VERIFIED end-to-end                           |
| Full Autopilot      | Claimed task through reviewed patch and verified PR          | NOT VERIFIED; review-only local draft proven      |
| Reliability         | Repeatable cold/warm, 7B load timeout resolved               | NOT VERIFIED                                      |
| Scale/billing       | External fault, multi-device and customer lifecycle evidence | NOT VERIFIED as general-availability proof        |

**Deployment distinction:** A source merge, a 101-tool public catalog and a
successful local-readiness gate do not by themselves prove that every device
is upgraded, every client has recaptured its schema, or the entire paid
enterprise lifecycle is complete. Do not treat an empty GitHub PR queue
as product completion.

## Troubleshooting

| Symptom                             | Action                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `LOCAL_MODEL_NOT_RUNNING`           | Check installed Ollama process on the approved device; no cloud fallback                         |
| `LOCAL_MODEL_NOT_INSTALLED`         | Select a model reported by `local_model_status`; do not auto-pull                                |
| `LOCAL_MODEL_BUSY`                  | Complete the active bounded request before trying another                                        |
| `LOCAL_MODEL_INFERENCE_FAILED`      | Record bounded latency/resource diagnostics, not secrets; evaluate cold loading                  |
| `DEVICE_TIMEOUT`                    | Separate MCP/agent timeouts from model loading; avoid blind repeated Autopilot checkpoints       |
| Missing MCP local tools             | Refresh the **existing** client's catalog and OAuth grant; verify a real authorized `tools/call` |
| A model produces only thinking text | Use bounded model-specific non-thinking controls and check visible response                      |
| Autopilot checkpoint already exists | Respect replay protection; do not overwrite a valid task checkpoint                              |

For production problems, attach **sanitized** tool name, commit SHA,
device/project IDs where safe, PASS/FAIL, elapsed time and exact error code.
Never attach enrollment credentials, OAuth tokens, private configuration
or unredacted customer prompts.

## Engineering and release verification

Relevant source and gates:

- `src/local-model.js`: loopback-only local inference and resource limits.
- `src/tools.js`: MCP tool schemas and explicit approval boundary.
- `src/autopilot.js`: task leases and checkpoint replay handling.
- `tests/local-model.test.js`,
  `tests/autopilot-local-draft.test.js`: deterministic contracts.
- `scripts/p720-local-benchmark.mjs`: bounded local benchmark.
- `scripts/p720-isolated-benchmark.ps1`: isolated pinned Windows
  benchmark launcher (verify its target SHA before execution).
- `run_quality_gate`: administrator-configured local test profile.
- [GitHub Control Center](GITHUB-CONTROL-CENTER.md):
  branch restrictions and exact-head PR/CI requirements.

Always use the latest reviewed release pin; a Windows updater or benchmark
pointing to an immutable older SHA does **not** automatically track current
`main`. Do not weaken path restrictions, OAuth, fail-closed gates, or
explicit owner approvals simply to obtain a green status.
