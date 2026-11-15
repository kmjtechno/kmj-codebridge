# Source-neutral provider quote review (advisory only)

This narrowly scoped utility implements **only** the useful idea from
[cporter202/generative-ai-arbitrage](https://github.com/cporter202/generative-ai-arbitrage):
compare prices for an equivalent generative-AI task. **No source code, model
catalog, affiliate links, advertisements, provider credentials or suggested
savings percentages were copied** from that repository. Its README discloses
an affiliate relationship; the repository does not declare a license. Its
pricing is not evidence of current production cost.

## Existing CodeBridge protections stay authoritative

CodeBridge already has `smart-model-router.js`, `model-failover-policy.js` and
`provider-quota-provenance.js`. They guard free-model admission, privacy,
quota and failover. **This utility does not feed those admission decisions.**
It cannot authorize paid inference, make HTTP requests, read keys, alter
provider settings, change the active chat model, or deploy anything.

`reviewProviderCosts({ quotes, referenceProvider, modelSpec, billingUnit,
nowMs })` is a bounded, read-only function in
`src/provider-cost-review.js`. The result includes:

- Cheapest quoted provider for the **same** caller-defined task specification
  and exactly equal billing unit.
- Optional **illustrative** savings against an explicitly chosen reference
  provider, calculated only when the reference has a nonzero price and there
  are at least two comparable quotes.
- Exclusion counts for mismatched spec/unit and quotes at least 24 hours old
  or dated in the future.
- Explicit `CALLER_SUPPLIED_NOT_INDEPENDENTLY_VERIFIED` provenance,
  `billableExecutionAuthorized: false`, and `providerRequestsMade: 0`.

Prices are **integer micro-USD per unit**, not floating-point percentages or
auto-refreshed price feeds. Supported units are per million input tokens,
per million output tokens, per image job, per video job, and per audio job.
For media, `modelSpec` must identify resolution, duration, audio inclusion,
quality and other price-affecting attributes. For LLMs it must distinguish
exact model version, tier and any differing service guarantees. Provider
branding alone does **not** prove that two model endpoints produce identical
results, have the same licensing rights or actually expose the claimed model.

## Conditions before connecting this to a dashboard

1. Retrieve official provider quotes through an **authorized server-side**
   path, record their timestamp and source internally, and verify that both
   offers cover truly equivalent output and usage rights.
2. Keep credentials in the existing encrypted vault. Expose to a dashboard
   only redacted provider name, normalized quote, unit, timestamp and status.
3. Display the computed percentage only as an **estimate**, with source
   evidence and time of observation; otherwise show **Price unknown**.
4. Do not route a coding or media request based on this comparison. The
   existing zero-spend/free-model safeguards and explicit owner authorization
   remain independent, mandatory gates.
5. Require dashboard QA and actual authenticated backend evidence before
   calling any future integration live.

The deterministic tests in `tests/provider-cost-review.test.js` use
**synthetic fixture prices**; they are not claims about any current vendor.
Run with `node --test tests/provider-cost-review.test.js`.

**Status:** utility plus unit tests only. No dashboard integration or provider
API connection is claimed.
