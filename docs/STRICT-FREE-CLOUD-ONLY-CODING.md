# KMJ TECHNO — Strict zero-cost cloud-only coding route

## Owner policy (2026-11-15)

Coding development should use **free cloud LLMs only**. Do not start,
download, probe, call, or automatically fall back to Ollama, llama.cpp,
Qwen3.5-9B or any other local inference engine. Do not use a paid provider,
funded key, credit-consuming fallback, unknown-price alias, or quota workaround.

The new read-only CodeBridge `model_route_plan` strategy
`verified-free-cloud-only` enforces this selection rule at planning time:

- Only `kind:"cloud"` can be selected, including every fallback; a local model
  remains excluded even if it would be cheaper, healthy or higher quality.
- Require `cloudApproved=true`, `free=true`, `enabled=true`,
  `health:"ok"`, `freeTierVerified=true`,
  `costPerMillionTokensUsd=0`, provider discovery less than 24 hours old,
  enough context and non-exhausted quota. For OpenRouter, require exact
  `vendor/model:free` ID. Nonfree, stale, 429/cooldown and low-context
  candidates are rejected.
- For private project source, require `privateCodeAllowed=true` from an
  owner-approved data-sharing policy; otherwise the plan blocks.
- No eligible free cloud results in `NO_FREE_AUTHORIZED_CAPABLE_MODEL` with
  `localFallbackAllowed=false`; it must **stop**, not silently select a
  local model or paid model.

### Existing FreeLLMAPI on P520

The FreeLLMAPI loopback proxy and its `auto:<chain>` adapter already exist in
source as `src/freellmapi-client.js`. Previously tested Zed
`free-router`/`kilo-auto` routes do **not** by themselves prove that every
upstream behind the chain is free, enabled, healthy, nonbillable and permitted
for confidential source. Verify these separately from the owner-controlled
FreeLLMAPI dashboard: every paid/funded key and every paid fallback must be
disabled. A chain must fail closed when no free route or tokens remain.

The CodeBridge `model_route_plan` tool is **advisory only**: all model
metadata supplied by the caller is untrusted. It never transfers a prompt,
changes ChatGPT's underlying model, calls FreeLLMAPI, enables a provider,
checks an actual billing balance or launches an autonomous worker. The real
provider transport **must independently check zero price, privacy permission,
owner-controlled credential and quotas** before executing any prompt.
FreeLLMAPI `paidInference:false` response metadata is not proof of actual
upstream pricing when the owner chain is unverified.

### Live readiness checklist

1. Dashboard: free cloud-only chain, paid/funded routes and fallback **OFF**;
   cost/account evidence from authoritative provider, no unexpected charge.
2. Provider: actual free-tier health, exact model ID, quota and context.
3. CodeBridge: deploy this feature only after reviewed CI and separately signed
   release; confirm the enrolled agent reports the new strategy and no local
   fallback.
4. Code transfer: owner explicitly authorizes private source to that provider;
   avoid secret/config/key files; record actual provider/model usage **after**
   a successful call.
5. Autonomy: free-only coding executor must have approved
   nonproduction, isolated worktree and bounded source allowlist; source PR
   alone does not start a coding worker.

No P520 local model, driver, service, GGUF file, paid subscription, environment
secret, production release, gateway or CodeBridge agent was changed by this
source-only planner PR.

## Quota-aware routing (advisory, source-only)

`model_route_plan` now plans **before** a free limit is hit, not only after a 429:

- **Declared limits.** A model may carry `limits: { perMinute, perDay }` (owner-declared free-tier
  ceilings, e.g. OpenRouter `:free` is 20/min and 50/day for accounts with under $10 of lifetime
  credits). The policy counts requests it is told about (`observe`) against them: a sliding
  60 s window and a UTC-day counter.
- **Headroom.** A model at or below 15% of a known limit (or with 2 or fewer requests left when no
  limit is known) is `lowHeadroom`. Healthy models always rank first; a low model is used only
  when nothing healthy qualifies. Exhausted models are not eligible at all.
- **Spread.** Between healthy models, the one with more remaining headroom is preferred, so load
  is spread across providers instead of draining one.
- **Rotate advice.** Pass `task.currentModelId` for a task already running: `rotateAdvised` is
  true when that model is low and a healthy alternative exists. Rotate at a safe boundary (between
  requests, with the checkpoint preserved), never mid-request.
- **Headers still win.** `x-ratelimit-remaining-requests` and `x-ratelimit-limit-requests`
  headers, 429 `Retry-After` cooldowns and 401/403 backoff behave as before.
- **State.** Counters live in the `quotaState` snapshot the host persists. If the host does not
  persist it, counters restart empty after a restart and the policy falls back to headers and
  429 cooldowns, which is less proactive but still fail-closed.

Limits are not discovered automatically. They change over time and must be entered from the
provider's current documentation or dashboard. A wrong, too-high limit only delays the switch;
it never makes a non-free or unverified model eligible: every earlier gate (free tier verified,
zero price, fresh health, private-code permission, no local fallback) still applies first.

This changes planning only. It does not call a provider, hold a key, enable `freellmapi_generate`
or switch the host chat model.
