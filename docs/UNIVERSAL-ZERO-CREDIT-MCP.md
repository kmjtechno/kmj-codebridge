# Universal CodeBridge — zero additional cost, bounded AI-context output

## Current research (October 17, 2026)

Audited the actual CodeBridge gateway, SDK dependency, stdio bridge and all
16 client-configuration formats against relevant GitHub projects:

- [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk):
  official MCP client/server SDK, the correct interoperable foundation.
- [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol):
  protocol documents, authorization, standard tools and protocol negotiation.
  In the published 2026-07-28 specification, Streamable HTTP moves toward
  stateless POSTs and new metadata; **do not silently replace the working
  earlier transport without a separate conformance/rollback PR**.
- [open-webui/mcpo](https://github.com/open-webui/mcpo):
  MCP-to-OpenAPI bridge, useful for clients that genuinely cannot speak MCP
  but can run an OpenAPI tool provider. It is **not installed here**.
  An API proxy must never bypass CodeBridge OAuth, owner grants or tool
  write/execute approvals and cannot create support in an app that has no
  external-tool facility.
- [punkpeye/awesome-mcp-clients](https://github.com/punkpeye/awesome-mcp-clients):
  directory of clients, not verified integration or security evidence.
- [mcp-use/mcp-use](https://github.com/mcp-use/mcp-use):
  cross-client MCP framework and potential browser/agent integration design;
  third-party frameworks bring dependency/audit overhead.
- [continuedev/continue](https://github.com/continuedev/continue):
  coding agent / IDE ecosystem. Do not replace CodeBridge's authorization
  or import a complete agent system just to lower token output.

CodeBridge _already_ generates remote OAuth configuration for ChatGPT/custom
MCP, Claude.ai/Code/Desktop, Codex CLI, VS Code/Copilot, Cursor,
Windsurf, JetBrains, Gemini CLI and generic clients. Every client has the
same `https://kmjtechno.com/mcp` endpoint. Successful configuration
generation is **not a claim of verified account-level OAuth, connector or
live device access on every client**.

## Implemented: compact authenticated read batch (no paid calls)

The existing, gateway-composed `fast_read_batch` adds optional
`responseMode:"compact"`, otherwise default `"full"` preserves legacy
interoperability. It continues to perform up to eight allowlisted read-only
calls under the exact same user, device and project authorization.

With compact mode, for successful calls:

- Respond with per-tool SHA-256 receipt of the complete JSON result,
  its byte length, data shape and up to a handful of _strictly allowlisted_
  boolean/integer/status hints; do not copy source files, arbitrary log
  strings, tokens, file paths or nested blobs into the model context.
- Failure codes remain explicit but invalid or unsafe strings fail closed
  to a generic error. Failures are **not** incorrectly reported as PASS.
- `detailsReturned:false` and
  `detailsRequireNewAuthorizedToolCall:true` are mandatory. No full
  results are cached or guaranteed reproducible on a later read. A SHA
  receipt does not attest device trust, tool success beyond the reported
  status, signing, or external source truth.
- Never use compact mode as a substitute for reading actual source
  content or full CI evidence required before a write, merge or deploy.
  Selectively call the same original tool in full mode when evidence is needed.
- The text output sent from the device to the gateway **still happens**;
  only the response returned to the AI client's context gets smaller.
  This does not reduce the host model's input prompt tokens, hidden internal
  inference work, transport request count or billable credits by itself.

Example (already connected client with authorized `device`, `project`):

```json
{
  "device": "authorized-device",
  "project": "authorized-project",
  "responseMode": "compact",
  "calls": [
    { "key": "git", "tool": "git_status", "args": {} },
    { "key": "capacity", "tool": "execution_capacity", "args": {} },
    { "key": "project", "tool": "inspect_project", "args": {} }
  ]
}
```

If a compact result says `ok:false`, inspect/retry the corresponding
approved read only after considering rate-limit and failure status.
Do not re-run destructive operations to fetch details. There is no new
write/execute tool in this feature.

## Other fast paths to reuse, not duplicate

- `fast_context`: one project/Git/autopilot snapshot.
- `context_pack`: bounded delta-first source context when source needed.
- `context_resume`: concise versioned checkpoint, not ChatGPT chat control.
- `hyperindex_search`/repo search: selective symbol and code retrieval.
- `large_prompt_plan`: 1 MiB integrity manifest, not text compression.
- `hyperspeed_plan`: quota/fenced DAG simulation, not worker execution.
- `engineering-observer`: review-only repeated-error proposals.

Avoid sending raw source or full logs to an unapproved free-cloud model,
assuming local model inference is free of electricity costs, silently
switching to a billable provider, bypassing developer/IDE restrictions,
or claiming unlimited credits/zero tokens. CodeBridge can reduce _avoidable_
model-visible tool output; inference itself consumes whatever quota the
client/model/provider uses.

## Acceptance / real measurement

- `node --test tests/compact-read-results.test.js`
- `node --test tests/interop.test.js` for live local gateway+agent+SDK;
  source-only tests do not attest hosted deployment.
- `node --test tests/universal-mcp-client-matrix.test.js`.
- Full `npm run check`, `npm test`, secret scan, Linux/Windows
  exact-head CI and hosted Smoke before declaring a production rollout.
- Compare same-project `fast_read_batch` full vs compact response JSON
  sizes and time to verified result. Record bytes and approximate model
  context tokens, but do **not** invent a token-price saving without the
  user's provider accounting and an end-to-end task benchmark.

Migration note: client-specific features such as elicitation, long-running
tasks, resume/subscriptions, SSE/stdio and latest 2026-07-28 MCP wire
format require separate compatibility testing. One URL does not magically
connect to apps lacking any supported MCP/API/plugin channel.


## Adaptive output mode (source candidate)

An optional `responseMode:"auto"` has been added to the same authenticated,
read-only `fast_read_batch`. This is an **opt-in** third mode; existing
clients continue to receive `"full"` by default.

- Failed tool calls are normalized to a safe error code and never
  mistaken for successful evidence.
- Small successful results (up to 512 bytes of serialized JSON per result)
  are returned in full with no extra receipt overhead.
- For larger results, the gateway compares the full JSON result with the
  already-existing compact receipt. It only uses the compact form if the
  saving is **at least 192 UTF-8 bytes and at least 20%**. Otherwise the
  original full result is preserved. This is an output-size heuristic,
  **not a model tokenizer, billing guarantee or signed attestation**.
- Compact rows carry `responseMode:"compact"` and
  `detailsRequireNewAuthorizedToolCall:true`. Unchanged small/full rows
  keep the legacy shape. There is no hidden storage or bypass for reads.
- Adaptive mode only changes what the **AI client sees**. Every requested
  tool still executes once with identical project and OAuth permissions,
  and device-to-gateway bytes are not reduced.
- Use actual `full` mode and required CI/source evidence for final
  decisions, not a compact hash or unverified status hint. A second
  authorized read is required when the result is not sufficient.

Example: `{"device":"approved","project":"approved","responseMode":"auto","calls":[{"key":"status","tool":"git_status","args":{}}]}`.

The threshold can be tuned only after measuring real task outcomes. Do not
force compaction when the follow-up fetch would consume more model credits.
