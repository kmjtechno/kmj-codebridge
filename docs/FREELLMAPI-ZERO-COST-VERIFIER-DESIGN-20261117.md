# FreeLLMAPI zero-cost verifier — design (not implemented)

Status: **design only. No code, nothing enabled.** `freellmapi_generate` stays blocked with
`FREELLMAPI_ZERO_COST_NOT_ATTESTED`. This document records what can and cannot be proven on
KMJ-elite today, based on the pinned upstream (`tashfeenahmed/freellmapi` @ `fd327a57`, read-only
review) and the existing adapter contract in `src/freellmapi-client.js`.

## Contract to satisfy (unchanged)

`verifyZeroCostChain({chain, ...})` must return, fresh (<= 60 s), for the exact chain:
`source = authenticated_provider_billing_and_route_binding`, `routeBindingVerified`,
`accountNoChargeVerified`, `noPaidFallback`, zero input/output price, `requestsRemaining > 0`.
It is injected by trusted device code only; chat/MCP arguments and env flags cannot supply it.

## Findings that shape the design

1. **The chain's model list is not reachable with the unified API key.** Upstream serves
   `GET /api/profiles/:id/models` behind a dashboard-session login (`requireAuth`). `/v1/models`
   only lists the chain name (`auto:<name>`) and an availability flag, not its members.
2. **A chain can contain any provider.** The live `free-code` chain was created from a catalog of
   ~330 models, including entries marked `trial`. Nothing in the router proves a member is free.
3. **Provider billing evidence exists for OpenRouter only.** `src/openrouter-free-evidence.js`
   (pure, tested, unwired) evaluates `GET /api/v1/key` and exact `vendor/model:free` zero-price
   entries. Groq/Gemini/others expose no equivalent account-billing API we can authenticate.
4. **Upstream does outbound catalog sync** (`api.freellmapi.co`, every 12 h). It carries no keys
   or prompts, but model membership/pricing metadata is upstream-controlled and must not be trusted
   as billing evidence.

## Proposed design (smallest honest verifier)

Scope the first verifier to **chains whose every member is an OpenRouter `:free` model**.

- **Route binding (owner-pinned + drift-checked).** The owner exports the chain's member list once
  into a root-owned, 0600 manifest (`/etc/kmj-freellmapi/route-binding.json`: chain name, exact
  model IDs, SHA-256 of the canonical list). At verify time a device-side reader compares the
  live membership, read **read-only** from the router's local SQLite (profile -> models) through a
  root-owned helper, against the manifest. Any difference, any non-OpenRouter member, any member
  that is not an exact `vendor/model:free` ID -> not attested. No dashboard password is ever
  stored or used.
- **Account billing.** Trusted device code fetches OpenRouter `GET /api/v1/key` with the owner's
  OpenRouter key (never the chat, never the router's copy) and `GET /api/v1/models` for the pinned
  IDs; feed both to the existing `buildZeroCostProof`. All-time/daily/weekly/monthly usage and BYOK
  usage must be exactly 0 and `free_model_daily_requests.remaining > 0`.
- **No paid fallback.** Attested only if the manifest chain has no non-`:free` member and the
  router's active/default chain cannot be selected by the caller (adapter already sends the exact
  `auto:<chain>` and rechecks before each POST).
- **Freshness.** Proof lifetime <= 30 s; the adapter's existing second check before each POST stays.
- **Fail closed everywhere:** unreadable DB, manifest mismatch, evidence fetch error, HTTP 402/429
  from the call -> `FREELLMAPI_ZERO_COST_NOT_ATTESTED` or the existing quota error.

## Explicitly out of scope / not provable

- Chains with Groq, Gemini, Kilo, OVH or any other provider: no authenticated billing proof exists,
  so they stay unattested. "Free tier" marketing or a `trial` label is not evidence.
- Data handling: free-tier prompts may be logged or trained on. Private/customer source still
  needs the owner's explicit approval and a provider-specific review.
- Spend that has already happened on the OpenRouter account makes it "not verified" by design
  (the key response cannot tell paid from free usage); the owner can use a dedicated zero-balance
  account to keep the check meaningful.

## Work breakdown (each a small reviewed PR, owner-approved before any wiring)

1. Read-only route-binding reader + manifest schema and tests (synthetic fixtures, no network).
2. OpenRouter evidence fetcher (HTTPS, owner key from a root-owned env, bounded, redacted) feeding
   `buildZeroCostProof`; tests with recorded-shape fixtures only.
3. Owner script to create the manifest (dry-run default) and a status field showing manifest/drift
   state, never the key.
4. Only then: a separate, owner-approved PR to inject the verifier. Real-account proof (a single
   `:free` call with before/after `/key` usage) is required before reporting it working.

## Open questions for the owner

- Is the OpenRouter account zero-balance and dedicated to this use?
- Accept OpenRouter-`:free`-only chains for generation (other providers stay read-only)?
- OK to let a root-owned helper read the router's SQLite read-only for drift checks?
