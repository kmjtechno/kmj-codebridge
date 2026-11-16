# OpenRouter free-tier evidence evaluator (source-only)

Status: **source-only, not wired, not proven against a real account.**
`src/openrouter-free-evidence.js` is pure (no network, no secrets, no imports) and no
other source file imports it (a test enforces both). It does not enable
`freellmapi_generate`; that tool stays blocked with `FREELLMAPI_ZERO_COST_NOT_ATTESTED`
until trusted device code supplies a `verifyZeroCostChain` that uses it with real evidence.

## What it checks (fail closed)

`evaluateAccountEvidence(GET /api/v1/key response)` is `ok` only if all of these hold:
all-time, daily, weekly, monthly credit usage and BYOK usage are exactly `0`; no blocking
budget or exhausted key limit; and `free_model_daily_requests` is readable with
`remaining > 0` and `used + remaining <= limit`. Any recorded spend, even from a paid
model, makes the account "not verified" because the key response cannot tell paid from free
usage. A negative balance can return 402 even on free models, so zero-usage is not enough
on its own for a working call; the call itself must still handle 402/429.

`isVerifiedFreeModel(entry)` requires an exact `vendor/model:free` ID and published
per-token `prompt` and `completion` prices that are the decimal string `0`.

`buildZeroCostProof({ chain, observedAtEpochMs, keyResponse, routeBinding })` returns the
object the FreeLLMAPI client expects, with a 30 s lifetime, or `null`.

## What it cannot prove

- **Route binding.** What a FreeLLMAPI `auto:<chain>` really routes to, and that no paid
  fallback exists, comes only from the owner-controlled router configuration. Trusted device
  code must supply `routeBinding` (`verified`, `noPaidFallback`, the model list). The module
  only checks that every listed model is an exact zero-price `:free` model.
- It trusts that the evidence was fetched with the owner's key over HTTPS by trusted code.
  Evidence from a chat or MCP argument must never reach it.
- It says nothing about data handling. Free-tier traffic may be logged or used for training
  by some upstream models, so private source still needs the owner's explicit approval and
  a provider-specific review (`privateCodeAllowed`).
- The `/key` field names follow OpenRouter's published schema; `is_free_tier` is
  deliberately not used because its meaning is ambiguous.

## Still needed before any generation is enabled

A device-side fetcher with the owner's OpenRouter key (never in chat or Git), a router
route-binding reader, a live check on the real account, a signed release, and the owner's
explicit go. None of these exist yet.
