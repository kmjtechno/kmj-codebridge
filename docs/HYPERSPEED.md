# KMJ HyperSpeed — free-only bounded multi-agent planning

This is **a read-only scheduler simulation, not a live model swarm**. It never calls AI models, starts CodeBridge jobs, enables an account plan, claims free quota or changes licensing. Run as `hyperspeed_plan` on an authorized CodeBridge project after the existing app's tool catalogue is refreshed.

## What the tool does

- Accepts at most 64 logical tasks with IDs, type, dependency IDs, file scopes, priority, estimated effort, and sensitivity class. Unknown dependencies, cycles and path traversal are rejected.
- Creates deterministic waves for tasks that do not touch overlapping file scopes or share unfinished dependencies. The next wave begins after the previous completes; no optimistic shared-directory writes.
- Hard caps active planned slots using **the actual connected CodeBridge runner's `effectiveMaxConcurrent`** (including resource pressure and legitimately provisioned concurrency). An unactivated Owner plan with 1 effective slot stays at 1; plans and licenses are never bypassed.
- Accepts up to 12 optional _caller-supplied simulation pools_ with kinds, allowed sensitivity, free/paid flag and modeled RPM/remaining requests. A paid pool is never selected. Actual provider quota and code-privacy approval **must be verified externally before executing**; `quotaVerified` is metadata, not trusted authentication.
- A local/CPU pool is excluded unless the caller explicitly sets `allowLocal=true` (cold-start last resort only). No persistent local LLM process or unapproved download is launched.
- Reports `modeledOnly: true`, `quotaEntitlementsVerified: false`, `authorizedSlots`, execution waves and blocked task reasons. No API key, endpoint, cost authorization, secrets or arbitrary command exists in the schema.

## Recommended eventual architecture (not implemented by this first slice)

`Kristi → mission DAG → bounded planner → ModelFabric provider-quota ledger → isolated role agents → CodeBridge fixed jobs → exact-head gates → reviewed merge/signing`.

Dynamic provider discovery needs **authenticated**, permissioned endpoints, rate-limit headers, per-provider organization quotas, adaptive capability scoring and failover checkpoints. Separate agents require bounded worktrees, idempotency and a real background service. Multiplying worker definitions does not create free inference capacity or independent running workers.

Cloud free pools documented as of 8 Oct 2026 (verify on the provider/account before enabling): [Groq](https://console.groq.com/docs/rate-limits), [Gemini API](https://ai.google.dev/gemini-api/docs/rate-limits), [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/), [OpenRouter](https://openrouter.ai/pricing/), [Hugging Face](https://huggingface.co/docs/inference-providers/pricing). Their quotas are limited and vary. Never send KMJ private source to a free inference provider unless its data retention and training terms are acceptable and the user has explicitly approved the route. Set production `maxSpendUsd=0` at the ModelFabric boundary, not merely in this planner.

## Performance acceptance

Measure each real project baseline, then compare median task elapsed time, 95th percentile latency, tokens per completed issue, CI retry count, merge defects and total monetary spend. Research suggests independent tasks can run concurrently; tightly coupled coding work and extra agents can increase overhead. Do not promise months of arbitrary work in minutes.

See [Issue #213](https://github.com/kmjtechno/kmj-codebridge/issues/213) for further implementation and future benchmark work.
