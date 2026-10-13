# Provider quota provenance for the CodeBridge broker

This standalone module is **zero-dependency** and does not make HTTP
requests, store keys, decide pricing, or claim cloud requests are free.

\`src/provider-quota-provenance.js\` exposes:

- \`observeProviderQuota({ provider, headers, statusCode, observedAt })\`:
  normalize **trusted** response headers for Groq, Anthropic, OpenRouter
  and generic OpenAI-compatible providers.
- \`observeProviderQuota({ provider: "openrouter", source: "openrouter-key",
  body, observedAt })\`: interpret **authenticated** OpenRouter
  \`GET /api/v1/key\` data; no direct API call occurs inside this module.
- \`quotaPressure(observation, { inputTokens, maxOutputTokens,
  requestHeadroom, tokenHeadroom })\`: a **switch suggestion**, NOT
  authorization to send inference or to charge a paid model.

The broker must independently enforce **tenant/project approval**, model
identity, actual documented **free pricing for that exact model/tier**,
private-code consent, request budget and a hard zero-spend mode.
A provider simply declaring \`free_tier="plan"\` is NOT sufficient evidence
that _every_ discovered model/request is free. The default remains
zero provider calls. Unknown free allowance is **unknown**, not unlimited.

## What the measurements mean

- **Groq:** \`x-ratelimit-remaining-requests\` is requests per day,
  \`x-ratelimit-remaining-tokens\` is tokens per minute. Neither is a
  balance or an invoice. Reset duration headers are parsed separately.
- **Anthropic:** requests, combined tokens, input tokens and output tokens
  can have independent limits and RFC3339 reset times. These are rate
  windows, not unspent subscription credits or Anthropic API balance.
- **OpenRouter \`/api/v1/key\`:** \`free_model_daily_requests.remaining\`
  is a verified remaining count _when present_; \`limit_remaining\` is a
  **key spending cap**, NEVER "free credits remaining". Each selected
  model must independently be marked free by its current pricing/capability
  metadata. OpenRouter account credit totals may require a separate
  management key: do not assume those are included in this response.
- **Unknown:** No compatible signal means that no balance or free quota
  can be asserted. Do not automatically enable a paid provider.

Provenance values \`verified\` and \`unknown\` refer exclusively to a
valid numeric field from an authenticated provider response. They do
**not** certify that a key, user, provider or model may run billable
inference for free.

## Integration contract with Claude's Main Platform AI Providers PR

Claude owns \`kmjtechno/kmj-main-platform\` PR #404 (PHP + TSX dashboard).
Keep this CodeBridge parsing module and its tests in a separate PR to
avoid overlapping edits. The main-platform broker may independently
implement compatible provider-specific parsing, or send safe structured
observations to CodeBridge after authenticating them; it must not allow
untrusted client-provided quota headers to authorize inference.

Future broker integration should:

1. Verify endpoint, tenant and owner permissions; store keys only in the
   server-side encrypted vault. Never send the key to the P720 device.
2. Read provider rate headers and source-verified usage endpoint responses,
   store redacted metadata with timestamp (no raw headers/key labels).
3. Update per-provider usage/reservation state atomically to handle
   concurrent jobs; a quota snapshot alone does NOT reserve tokens.
4. If a bounded next task would exceed reported requests/tokens/daily
   free-model limits, checkpoint and select a different explicitly
   authorized free model (or local Ollama) while preserving context.
5. Respect 429 Retry-After and provider reset times; never evade limits
   with rotated accounts or API keys.
6. Show "Unknown", "Verified rate limit" and "Verified free-model daily
   requests" as different UI labels. Do not label a key spending cap or
   rate window as an unspent free-credit balance.
7. Require production-side verification and fault-injection before enabling
   live provider switching. These parsers are not production routing.

## Upstream documentation (as of October 2026)

- Groq: https://console.groq.com/docs/rate-limits
- Anthropic: https://platform.claude.com/docs/en/api/rate-limits
- OpenRouter limits: https://github.com/OpenRouterTeam/docs/blob/main/api_reference/limits.mdx
- OpenRouter key: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key

No provider keys, payments, production settings or dashboard components
are modified by this PR.
