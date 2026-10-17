# KMJ Large-Prompt Fast Path (read-only, zero additional cost)

## Research: existing CodeBridge components

Live GitHub source was compared at `kmjtechno/kmj-codebridge@44e3d20915040a0871fbfbef2025f5253b4001ea`:

| Existing capability | What it already does | Limitation |
|---|---|---|
| `fast_context` | One authenticated MCP call combines Git/project/task state | Does not analyze a huge initial user prompt |
| `fast_read_batch` | Parallelizes up to eight allowlisted project read checks | Inner calls remain separately authorized; this does **not** increase model speed |
| `context_pack` | Delta-first, 12/32/64 KiB coding context | Not a lossless user-prompt storage system |
| `context_resume` | Versioned compact checkpoint, stable digest | Cannot expand ChatGPT's native context window |
| `hyperspeed_plan` | Simulates permissioned DAG waves up to 64 tasks | Does not execute workers or verify model quota |
| `hyperindex` | Bounded local repository code search | Does not parse natural language task dependencies |

### New source implementation

`src/large-prompt-plan.js` is a deterministic, **lossless source manifest** for opt-in inputs with at most **1 MiB UTF-8**. New project-scoped, read-only MCP tool: `large_prompt_plan`.

1. Input is supplied **once by the authorized client**, and the tool returns a SHA-256 of the full prompt and ordered UTF-16 start/end offsets, per-range byte counts and hashes. The original remains with the caller and is **not echoed, stored, sent to an AI model or executed** by the planner. The existing CodeBridge transport still receives the submitted input; do not send sensitive prompts without trust/authorization for that device and gateway.
2. Default range size is 16,384 UTF-16 code units (configurable 8192–32768). Boundaries prefer later Markdown headings and line endings; splitting a long fenced code block is flagged. UTF-16 surrogate pairs and CRLF pairs remain together; invalid surrogate sequences fail rather than being silently replaced.
3. A caller with the same prompt SHA may provide `ifNoneMatch` to obtain a tiny unchanged response. **The tool still receives the supplied prompt** to verify the digest; this is *output* deduplication, not a network bypass.
4. The manifest contains **no extracted commands, paraphrased requirements, execution permissions, evidence of completed work, or automatic parallel scheduling**. A client must keep and verify every original range and preserve ordering, dependencies and policies.
5. Inputs exceeding 1 MiB are explicitly rejected rather than truncated. To handle larger requirements, the client should use a separately approved project file or manifest workflow with bounded read ranges and integrity receipts. This version does not implement file ingestion or promise unlimited context.
6. The tool is opt-in and not part of automatic `fast_read_batch` (passing huge text nested in eight calls could worsen latency and context). It performs no backend inference, queue modifications, writes, downloads, provider switching or token billing.

### Suggested fastest safe workflow

- **Small prompt:** Answer normally; do not add a redundant planning call.
- **Complex multi-repo prompt:** Use existing `fast_context` once, `context_pack` for relevant diffs and `fast_read_batch` for independent reads. Use `context_resume` digest to avoid needless replays. These are permission-checked tools, not unlimited parallel workers.
- **Very large prompt:** If an authorized client can retain the entire original text, call `large_prompt_plan` once to obtain integrity and splitting warnings. Never send chunks individually to cheaper/free cloud providers without the caller's approval or claim token-window capacity the model lacks. Verify all parts before processing.
- **Execution:** Only separately authorized worktree lanes/tasks and CI; apply `hyperspeed_plan` for modeled DAG capacity, not as a permit for new jobs.
- **Over-context request:** Do not silently compress mandatory instructions. Request an explicitly scoped source-of-truth artifact or preserve all requirements with verifiable offsets and resumable state.

### Synthetic benchmark and acceptance

```sh
node --test tests/large-prompt-plan.test.js tests/large-prompt-tool.test.js
node scripts/benchmark-large-prompt.js
npm run check
npm test
```

Benchmark reports local CPU median/p95 and output manifest byte size for synthetic 32 KiB, 256 KiB and 1 MiB text. **It does not measure ChatGPT response generation, model prefill, provider throughput, network RTT, or end-to-end workflow latency.** Any "HyperSpeed" end-to-end claim requires same-prompt controlled tests (median/p95 completion time, token and tool request counts, missing requirements, CI defects, cost). A manifest can even add overhead for tasks too small to justify it.

Safety: keep original user instructions intact, secrets private, Cloud LLM routing opt-in, zero additional spend, source-only until the exact-head CI and live agent deployment are independently verified.
