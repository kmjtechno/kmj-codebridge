# KMJ CodeBridge — hosted monthly tool-call plans (proposal)

**23 November 2026 · SOURCE ONLY · NOT DEPLOYED · NOT A CHECKOUT OFFER**

## Why this plan

Desktop Commander Remote's [official plans](https://desktopcommander.app/help/account-billing/plans-and-tool-call-limits) describe **10,000 completed tool calls/month Free** and **US$20/month Pro with unlimited tool calls**. Its separate [open-source local MCP](https://desktopcommander.app/pricing/) stays free with no monthly call limit. This is a comparison of **Remote hosted usage**, not AI inference credits, and CodeBridge is not a feature-for-feature clone.

KMJ CodeBridge's existing owner-approved India pricing **does not change**: Pro **₹299/month or ₹2,499/year**, Team **₹699/user/month (minimum 3)**, Community **₹0**. Global Pro US$7/month or US$59/year and Team US$10/user/month also remain unchanged. Business stays quote-based. This proposal adds understandable **monthly hosted-call allowances**, not third-party model tokens and not a new billable SKU.

## Proposed hosted monthly allowances

- **Community — 10,000 remote device tool calls/month per hosted account**, free forever, no card; retain 1 authorized device, 1 project and 1 concurrent job.
- **Pro — 100,000 remote device tool calls/month per hosted account**, retain 3 devices, 10 projects and 3 concurrent jobs.
- **Team — 300,000 remote device tool calls/month per paid user seat**, retain 10 devices, 50 projects and 10 concurrent jobs **per user**; minimum 3 paid users. Track the seat's identity server-side; do not multiply one seat's allowance by connected devices or AI chats.
- **Business — a negotiated quota, price and rate policy** in an accepted order; never silently claim unlimited.
- **Apache-2.0 self-hosted core — no KMJ-hosted monthly tool-call meter.** Self-hosted use remains subject to administrator/device guardrails, computing resources and third-party provider terms. KMJ branding/hosted subscription rights remain separate.

These are **proposed** allocations in `product/codebridge-product.json` (`launch.hostedUsageProposal.status = proposal_only`), propagated into generated product catalog JSON. They **do not authorize any live charging, create a subscription, alter deployed gateway enforcement or make paid features available**.

## What counts and what never counts

- Count **one** permitted, device-delivered, completed MCP tool execution once per stable server-generated request/attempt ID. A completed execution returning an application/tool error still counts. A long-running approved quality gate is **one tool call**, not every internal test or file it processes.
- Do **not** charge a tool call for denied OAuth/tenant/permission checks, blocked plans, duplicate/replayed idempotency keys, a failed outbound delivery, unknown connection state, a gateway timeout before confirmed completion or simply reading the CodeBridge usage summary. A cancellation request itself does not count.
- Distinguish `completed`, `failed_application`, `not_dispatched`, `delivery_unknown` and `transport_failed` in the future ledger. `delivery_unknown` is **pending reconciliation**, never an invented success or a blind retry, until the device's signed/authorized receipt resolves it. Do not double count one device execution after timeout/reconnect.
- The unit is **CodeBridge remote MCP device executions**, not ChatGPT/Claude messages, LLM requests/tokens, CI step count, AI-provider credits, GitHub API operations or billing events. The user pays any opted-in third-party inference fees directly under their provider's terms.

## Reset, exhaustion and upgrade experience

1. Use **UTC calendar months**, reset on the **1st at 00:00 UTC**; show a precise UTC reset timestamp, account-wide used/remaining counts and plan-specific limits. No unused carry-over. Paid subscription renewal dates are separate; changing month does **not** renew or charge a subscription.
2. At **80%** consumption show an in-app/connector usage warning; warn again at **100%**. Don't send unsolicited marketing messages. For accounts upgraded mid-month, apply only the new signed entitlement's valid window and make a monotonic ledger transition; never use client-submitted price, plan or claimed consumption.
3. At the actual hard limit, **pause new metered remote device operations** with `MONTHLY_REMOTE_TOOL_CALL_LIMIT_REACHED`, showing remaining (0), next reset and plan choices. Keep read-only `usage_status`, account/device disconnect, cancellation of already running work, billing support and security revocation available; do not strand data or charge overages.
4. **No overdraft, automatic top-up, forced card, silent upgrade or paid AI fallback.** An upgrade needs Main Platform's approved offer, explicit customer consent, verified captured payment, authorized entitlement and secure gateway refresh; if commercial activation is not complete, retain Free plan and explain unavailability.
5. Running approved jobs should finish under their pre-existing bounded resource limits if reserved before the hard cap; ledger settlement must be idempotent even if jobs complete after month-end. A new call against an expired/unknown license is denied before quota accounting.

## Main Platform implementation contract — NOT YET BUILT

The **KMJ Main Platform** is the only hosted plan, consent, billing and quota authority. A device agent cannot authoritatively count calls across every machine and chat. A future narrow production PR needs:

- An immutable owner-reviewed plan/version/region snapshot, explicit effective date, seat identity and source-of-truth KSLP entitlement. **Do not reprice existing paid subscriptions.**
- A PostgreSQL usage ledger keyed by (organization, entitled account/seat, UTC period, request ID), tenant isolation, idempotent unique constraints, server time and atomic reservation/finalization. Concurrent calls must not exceed the plan's hard budget; cross-device and cross-chat usage share one quota.
- A grant check before and after reservation (OAuth, actor, device/project, product, active licensing, no revoked/suspended tenant), a short bounded pending reservation expiry and a fail-closed reconciliation path. **Reservation is not a counted completed call.**
- A verified authorized device receipt identifying the one execution; if only the transport fails or the outcome is uncertain, do not invent an extra charge. Cancel/reconcile pending operations without releasing a reservation which may have completed; keep append-only audit evidence.
- An account-facing **Usage & Plans** screen in the ONE Licensing Hub: progress bar, **used / limit**, next reset UTC, warning, downloadable history and plan-specific upgrade/cancel workflow. Separate the billing renewal date and the metering reset date.
- Contract tests: first/last second of a UTC month, leap year, time-zone mismatch, simultaneous 10k+1 calls, retry after gateway crash, queued/running cancellation, multi-device/multi-chat same account, team seat boundaries, counter replay, denied tools not counted, refunded/revoked entitlement, monthly plan switch, no paid fallback and no self-hosted limiter.
- Rehearsed PostgreSQL migration/rollback and disaster recovery; independent authenticated gateway + Windows device E2E, cross-language entitlement checks, privacy/security review and protected Elite release. **Feature flags default OFF** until all proofs and commercial approvals are true.

## Product-led acquisition and retention: earn repeat use, do not manufacture dependence

The commercial objective is **more successful developer work per returning user**, not forced notification clicks, surprise charges, lock-in or intentionally crippling Free. Offer real export of project context; keep the portable Apache-2.0 core useful.

### Five-minute first-value path (proposed workflow, NOT yet one-click-certified)

1. **Connect one authorized device without paying.** Choose ChatGPT, Claude, Codex or another supported MCP client; sign into Main Platform and approve the device and exact project. No GitHub authentication prompt in the owner dashboard and no broad shell approval. If pairing fails, show one actionable reason instead of offering an unsafe workaround.
2. **Get one valuable answer.** The first action is a single scoped `workspace_home` / project summary: file tree, stack, Git state, allowed quality gates and what can safely run. Never force the model to re-read an entire roadmap in each new chat.
3. **Finish one real job.** Offer "Inspect my project", "Find a bug safely" and "Run one approved check" as honest, permission-bound presets. Write requires explicit project capability; deployments and signing require separate approval.
4. **Resume with one click next time.** Save a tenant/project-scoped, versioned non-secret project summary, completed gate receipts, last task and safe next action. Across AI chats, show the same authorized workspace state; expire/refresh summaries after code changes, with user-visible export/delete. This is a planned experience, not a claim that all cross-client handoff already works.
5. **Show earned value.** A factual "3 safe fixes reviewed, 2 checks passed" history and a clear monthly **remote calls used / remaining** count. No fabricated automation progress, no hidden prompts, no arbitrary streak penalties and no data use for ad targeting.

### Conversion moments that help the customer

- The first genuine need for **a second device or project** is a natural Pro offer; Free still lets the user complete work on the first one.
- A team inviting another developer or needing managed policy/audit is a natural Team offer. Team requires a **minimum of 3 real paid seats** under the existing price; do not auto-enrol teammates or resell one seat as many.
- At **80% of monthly calls**, show remaining quota, exact next reset, ways to reduce redundant operations, and a reversible upgrade comparison; no panic timer or countdown unless it reflects a real UTC reset.
- Offer a **card-free, opt-in 14-day Pro trial** only after the signed KSLP trial and abuse-control lifecycle is deployed. Default on expiry is Community; never auto-charge or erase project data.
- For annual Pro, preserve the existing published **₹2,499/year** reference, about 30% below twelve monthly payments of ₹299. Actual checkout must disclose taxes, cancellation/refunds and renewal in advance. Do not advertise live sales or a founding scarcity offer until independently approved.
- Add a voluntary "Help me onboard my team" contact path for a **real qualified** org; prioritize 1–3 genuine design partners over fake install counts. No scraping, unsolicited automated mail, forced referrals or fabricated testimonials.

### Acquisition channels, low fixed cost

Start with existing GitHub plugin quickstarts and the Main Platform product page, then publish **specific reproducible demos**: review a real authorized repo, perform a hash-guarded edit, run a safe check, resume a long-running task in a second chat. Clearly distinguish "source verified", "test verified" and "deployed on customer device". Create bilingual English/Hindi onboarding without promising unsupported local OS access. Invite opt-in customer feedback and community contributions; do not manipulate ratings or stars.

### Cohort dashboard and decision gates (targets to test, not observed results)

- **Activation =** signed-in, device grant approved, one project selected, one authorized project-inspect tool actually completed. Target the **first useful result within 5 minutes** for a typical supported client on a clean enrollment; collect anonymized duration only with appropriate consent.
- **D1/D7/D30 repeat value =** an active customer account with at least one real completed authorized tool call on those days. Do not count bot pings, internal health polls, CI or owner automation as active customers.
- **Qualified paid conversion =** independently verified paid subscription linked to KSLP entitlement; separate Pro trials, Team seat count, cancellations/refunds and opt-in contact requests. Do not invent conversion rates; the ChartMogul 2026 study reports 8% median free-to-paid across a mixed set of 200 B2B software products, **not** a forecast for CodeBridge.
- **Gross-margin gate =** actual net recognized subscription revenue less measured gateway fees/refunds, support costs and server/relay/network variable costs. Aim for **≥70% variable margin** after instrumented evidence, not from a fabricated assumed low cost. The 100,000 Pro calls/month allowance is a **proposal**, subject to real production capacity tests and publication of any prospective changes.
- Segment by active users and **authorized hosted workspace**, not by chat count alone; protect tenant privacy, minimize analytics content and support account deletion/export obligations.

### Ship order for fastest sustainable revenue

**P0:** frictionless Free first-value, truthful usage preview + source-only pricebook; **P1:** atomic cross-chat/monthly metering and user-facing usage meter; **P2:** opt-in trial, protected KSLP signed lease, merchant capture/refunds/cancel and live customer end-to-end proof; **P3:** consented Pro/Team checkout, annual plan, partner demos and measurement. Gate every production switch on verified security and commercial evidence, not just CI.

## Release and status

**Implemented in this PR:** versioned, generated *proposal* metadata and strict static checks; published developer-facing specification. **Not implemented:** atomic DB metering, live call counts, UI progress, warnings, actual pause at 10,000, monthly reset worker, commercial checkout, real paid account entitlement or device signer interoperability. CI success never proves these production behaviors.

Keep `docs/PRICING.md`, `docs/LICENSING-HUB-SUITE-PLANS.md`, generated product JSON and Main Platform owner-only pricebook aligned. Do not silently change existing ₹299/₹699 India plans while introducing this monthly allowance.