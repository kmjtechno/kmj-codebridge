# KMJ CodeBridge — AI Chat Model Transparency (P0)

**Review-only code candidate · 2026-10-14. Not yet deployed.**

## User requirement

Every ChatGPT, Claude, Gemini, VS Code or other authorized CodeBridge client should be able to tell which **CodeBridge model actually executed** an inference, rather than displaying only an admin-selected provider/default model. Do not mistake the external chat host's own underlying assistant model for the model called by a CodeBridge tool.

## Evidence-backed model receipt

A successful `local_model_generate` invocation now includes `modelUsage`:

```json
{
  "provider": "local-ollama",
  "model": "qwen2.5-coder:7b",
  "execution": "verified_local_generation",
  "operation": "local_model_generate",
  "routing": "local-only",
  "cloudFallback": false,
  "paidInference": false,
  "scope": "codebridge_invocation",
  "hostChatModel": "not_observable_by_codebridge"
}
```

The existing direct-model result already reports model and provider. The explicit named receipt gives any client/chat a consistent object to render alongside a response. **This feature does not change the host ChatGPT/Claude/Gemini UI or force the chat assistant to render a badge.** The client may show the receipt or the assistant can summarize it in text.

`autopilot_local_draft` now saves this minimal record **with its existing lease-fenced Autopilot checkpoint**, so retry/replay reports which model generated the original draft, not the *current caller's* selected model. Existing legacy checkpoints have no proof; they return `model: null`, `execution: not_verified` rather than making up history.

The unattended local-draft worker also stores the actual local model in its task checkpoint. Inspect the task with `autopilot_status`; a queued or failed task **has not** generated a model response.

The already advertised read-only `connection_doctor` now includes `modelUsageStatus` with:
- `lastVerifiedInvocation` per authorized device+project **since the current agent process started** (or null);
- `observedAt` of a successful local tool invocation;
- explicit `originalChatHostModel: not_observable_by_codebridge`;
- no suggestion that this is a **per-chat** history. Multiple chats on the same project could share this project-level latest observation; always prefer the exact per-call model receipt.

## What this cannot yet show

- **ChatGPT/Claude/Gemini's internal host model**, or its private routing and thinking effort. CodeBridge doesn't receive this metadata from those clients; only the client itself can present its own assistant model identity.
- **OpenRouter/Main Platform cloud inference**. A healthy provider list or a configured free model is **not** an executed inference. Cloud generation requires an authenticated organization/project scoped server-side proxy and a verified response receipt (P0 CodeBridge issue #406). Do not guess which `:free` model answered from the configured default, especially with fallback routing.
- **Zero-cost guarantee** for cloud models solely from a name or a health check. Existing local inference is no-API-charge, not zero hardware/electricity cost.

## Non-negotiable security and release gates

- No provider keys, task objectives, prompts, responses, raw headers, session tokens or lease tokens in model attribution. Only static enums and strict 96-character model ID allowed.
- No modifications to production AI model settings, paid billing, device registration, DNS or persistent customer data.
- Keep current dirty P720 and CloudOS worktrees untouched; use exact-head Windows/Linux CI and approved signed staging update.
- Model attribution must never assert `verified_local_generation` if the model service errors, returns no visible text or a task only sits in the queue.
- After runtime update/reconnection, test through a real authorized `local_model_generate` MCP call, then inspect its returned `modelUsage` and the read-only `connection_doctor` last-used summary. **Source merge alone is not deployed UI functionality.**

**Client-facing suggested text when a tool actually returns a verified receipt:** `CodeBridge model used: local-ollama / qwen2.5-coder:7b · local, no cloud fallback · CodeBridge tool only`.

If no verified model call occurred: `CodeBridge model used: Not verified (provider configured does not imply inference)`.
