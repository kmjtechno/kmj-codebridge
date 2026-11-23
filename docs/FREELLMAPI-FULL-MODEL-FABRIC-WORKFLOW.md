# KMJ Model Fabric — FreeLLMAPI native workflow integration

Status: GitHub source candidate only. This does **not** configure provider accounts, buy paid routing, install an agent, start autonomous coding or activate production. FreeLLMAPI upstream was reviewed at commit `7619c8fee886eeba8f28c84d5fc943f4459c1fbc` on 23 November 2026. Upstream: https://github.com/tashfeenahmed/freellmapi (MIT; advertised for personal experimentation only). No third-party source was vendored.

## Target: one KMJ Model Fabric, one FreeLLMAPI inference engine

The production-facing model path remains:

`KMJ dashboard / scoped CodeBridge MCP → project grants + owner source-transfer consent → FreeLLMAPI Model Fabric → trusted zero-cost route admission → loopback FreeLLMAPI router → explicitly pinned, no-charge cloud upstream`

The upstream router already provides encrypted provider keys, named profiles, fallback, health, quota and catalog management. CodeBridge **reuses** that owner-managed backend. It does not build a second provider key vault or copy tokens into ChatGPT, GitHub, device logs, user prompts or the KMJ Main Platform database. The KMJ control plane observes safe metadata and enforces independent gates before inference.

## Owner setup / full happy-path UX

1. **One-time secure install**: trusted owner installs FreeLLMAPI under the supported license and deployment policy; bind loopback only. Its UI handles key enrollment, key testing, custom endpoint setup, encrypted key storage and profile chain editing. No automatic provider key creation or secret echo in CodeBridge.
2. **Connect models**: owner chooses supported truly free models and eligible accounts; creates narrow `auto:code` or `auto:coding`, `auto:fast`, `auto:reasoning`, `auto:default` profiles. Unqualified global `auto:smart`, `auto:fast` strategies can rank *every* enabled upstream; a route is **not** safe just because the alias is called fast/smart.
3. **Model discovery and diagnostics**: CodeBridge `freellmapi_status` reads `GET /v1/models`, filters only owner-approved `auto:<chain>` names and reports task candidates, unavailable/key-needed/exhausted chains and unverified pricing. A missing or malformed catalog fails closed; unknown readiness is not treated as actual successful inference.
4. **Optional usage dashboard**: `freellmapi_status({includeUsage:true})` also reads authenticated loopback `GET /v1/usage`. Returns only aggregate month/request/token counts; redact provider key IDs, labels, tokens, endpoint URLs and per-key rows. Missing/unavailable usage is explicit. This is **not proof of free billing**; upstream provider prices, credits and route members must be checked separately.
5. **Smart task routing**: code uses a coding profile first, reasoning uses the reasoning/smart profile, fast work uses fast/reliable profile, ordinary tasks use balanced/default. Only approved, advertised and not *explicitly* router-blocked routes are candidates. A recent 429 causes a 30-second bounded per-route cooldown, reducing repeated quota failures across calls. The owner-pinned verifier rechecks the actual route before **every** remote POST, including a retry.
6. **Bounded execution**: existing `freellmapi_generate` or skill-backed optional `skillId` sends one limited, owner-approved request with no paid or local fallback. The upstream `X-FreeLLM-Task-Type` advisory header biases scoring toward coding/chat when supported; this cannot widen approved route membership. One request may retry a **second approved** chain only after an unambiguous 429 and within one time budget; ambiguous 5xx, timeouts, partially streamed output and malformed completions are **not** automatically replayed.
7. **After completion**: CodeBridge treats returned text as untrusted; separately saves a sanitized cross-chat checkpoint, runs allowed repo/OS checks in isolated SHA-guarded lanes, and requires exact-head CI/review and original owner Elite signing for a release.
8. **Errors and recovery**: denied/paid/unknown price, private-code consent missing, missing chain/old agent, exhausted quota, expired owner attestation and closed router remain **BLOCKED** rather than silently falling back.

## KMJ improvement vs default router behavior

- A provider's `execution_status=ready` means a key may serve it **right now**, not that its usage is free or its code-transfer policy is acceptable.
- Global `auto:smart`/fast aliases are never trusted as no-paid guarantees; the trusted owner snapshot of real member IDs and independent account price evidence is mandatory.
- Route rejection is visible at the metadata level without a prompt POST.
- Rate-limited approved route cooldowns stop repeated failed cloud attempts until reset or operator retry.
- Usage is aggregated with per-key PII/secret data redacted, and it is not mislabeled as remaining free credits.
- Only error-safe 429 fallback, unlike general upstream retry on 5xx, prevents ambiguous duplicate code transfers under KMJ's stricter default policy.

## Integration decision: reuse vs intentionally exclude

| Upstream FreeLLMAPI capability | KMJ approach |
| --- | --- |
| Provider/key onboarding, encrypted keys, key health | Reuse FreeLLMAPI local dashboard; CodeBridge metadata-only |
| Named profiles, per-chain routing policies | Existing owner-approved `auto:<chain>` profiles with explicit task strategy |
| Smart model scoring and per-key quotas | Reuse router; augment with CodeBridge readiness/cooldown and independent zero-cost proof |
| Live model discovery/catalog | Read-only `GET /v1/models`; no unsigned auto-enabling |
| Monthly request/token usage | Optional privacy-preserving `GET /v1/usage`; not a billing attestation |
| Automatic failover | Only bounded, reverified 429; do not auto-replay ambiguous failures |
| Streaming, tool calls, vision, embeddings | Separate future adapter gates for protocol validation, tool execution safety, privacy and cost; **not enabled by this change** |
| Fusion/parallel generation | No automatic multi-model fanout; each provider request must be independently verified and explicitly approved |
| FreeLLMAPI MCP administration and route CRUD | Keep privileged provider-key/profile mutation in owner UI; no generic admin MCP exposure |
| Auto catalog updates and enterprise SLA | Do not assume model lists, pricing, capacity, privacy, license or SLA are guaranteed by upstream counts |

## GitHub release acceptance

- New policy and integration tests cover owner allowlist, catalog negative states, read-only usage redaction, per-chain 429 cooldown, task hints, no fallback after ambiguous error, consent and independent chain pricing attestation.
- Existing CodeBridge unit test, formatting, Linux+Windows CI, distribution and registry manifests must pass at the exact new commit.
- Source PR + CI do not prove a live router, actual provider zero-cost charge, installed P520 tool parity, 24×7 coding, device approval or signed Elite runtime. Require explicit live receipts for these.

**Zero additional spend is a hard admission requirement, not a marketing estimate from public provider counts.** Private source transfer and actual commercial hosting terms must be separately reviewed before enabling production prompts.
