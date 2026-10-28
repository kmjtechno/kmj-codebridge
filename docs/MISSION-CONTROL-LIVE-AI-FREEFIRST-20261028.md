# CodeBridge Mission Control: verified progress, AI chat and zero-cost models

> Source candidate for review (2026-10-28). A merged commit is **not** a deployed gateway, updated agent, installed 24x7 worker, connected model provider or production release.

## Delivered source behavior

- The existing MCP Apps Mission Control retains the locked KMJ identity, Workstream job receipts, verified task counts, capacity limits and no fake completion percentages.
- New **Send to connected AI chat** explicitly uses the stable MCP Apps `ui/message` request from a user click, after an authorized tool snapshot and host handshake. Host can deny. The model belongs to the host client, not an unseen CodeBridge cloud provider; no model identity is fabricated.
- New **Queue approved development task** explicitly uses MCP Apps `tools/call` for CodeBridge's existing `autopilot_enqueue`, with the same authorized device/project as the latest server tool output. It cannot supply shell, paths, production approval, API keys, scheduling or execution bypass. Server permission checks remain authoritative. A tool ACK only proves queue submission, not worker claim or work completion.
- The injected `getLiveDashboardMetrics` report now carries `developmentProgress` strictly from recent, tenant-authorized device/project observations. Missing, stale or partial data remain unknown. Read-only 90-second freshness, and verified recent jobs filtered by project and device. No polling from an untrusted webpage.
- `selectFreeFirstModel` is a **planner only**. It prefers verified healthy local inference; otherwise permits a proposed OpenRouter `:free` model only if actual pricing/account no-charge proof, explicit owner consent, current quota and no-paid-fallback are supplied. It makes **zero** network requests, purchases or model invocations. It must not be presented as a connected provider.

## Open-source review (licenses checked against public GitHub metadata)

| Upstream                                                     | Relevant capability                          | Adoption decision                                                         |
| ------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------- |
| [OpenCode](https://github.com/anomalyco/opencode) (MIT)      | coding session model/tool abstraction        | reference patterns; no wholesale agent duplication                        |
| [Aider](https://github.com/Aider-AI/aider) (Apache-2.0)      | test-driven coding and Git-aware workflow    | adapt reviewed ideas only                                                 |
| [Cline](https://github.com/cline/cline) (Apache-2.0)         | human-in-the-loop tools and AI task planning | preserve CodeBridge's stricter project/lease/permission boundary          |
| [Ollama](https://github.com/ollama/ollama) (MIT)             | owner-hosted local inference                 | preferred when an authenticated runtime probe verifies it                 |
| [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) | portable, sandboxed UI/host chat bridge      | use protocol rather than copying UI packages                              |
| [LiteLLM](https://github.com/BerriAI/litellm)                | normalized multi-provider gateway            | review optional integration; it does **not** make upstream inference free |

Sources: https://github.blog/changelog/2026-07-30-github-models-is-now-retired/ (GitHub Models retired); https://openrouter.ai/pricing (free rate limit ~50 requests/day, subject to change); https://developers.cloudflare.com/workers-ai/platform/pricing/ (10,000 free neurons/day; paid plan may charge above allowance); https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/main/specification/2026-01-26/apps.mdx (MCP Apps ui/message and tools/call). Never hardcode pricing or infer remaining free allowance from a model name.

## Staging + live acceptance

1. CI on exact PR head: JS tests, syntax, Linux/Windows, MCP dashboard host-denial, task enqueue, unauthorized scope and zero-charge routing.
2. Owner-approved signed CodeBridge gateway/agent upgrade, preserving existing device enrollment, licenses, permission grants, locked branding and supervisor restrictions; verify runtime version and live MCP Apps UI compatibility.
3. Connect the model only through owner-issued private credentials, verified free-tier rate limits and explicit consent. Fail closed on missing quota or any paid fallback. Cloud providers are optional, not a prerequisite for local coding.
4. Start only approved, pinned, isolated CodeBridge coding workers and read real worker receipts/uptime from authorized devices; 24x7 is **not** proven by a configured queue.
5. Independently inspect staging/dashboard, submit safe instruction, confirm queued/running/CI result with screenshots and owner approval. Production symlink/database/Nginx cutover follows its _separate_ protected release gate only; never infer it from a source merge.
