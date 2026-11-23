# KMJ CodeBridge — Launch Plans

> Launch packaging for KMJ CodeBridge. Checkout, taxes, regional pricing and availability are controlled by KMJ Main Platform. Until live checkout is enabled, this page is the commercial launch target rather than an offer to sell.

KMJ CodeBridge keeps the open-source core useful while reserving hosted convenience, higher limits, team controls and commercial operations for paid entitlements.

## Launch plans

Owner-approved on 2026-11-13 (see [Suite plans](LICENSING-HUB-SUITE-PLANS.md) for the reasoning and the plan-change policy). Prices are list prices and may change prospectively with notice.

- **Community: free forever.** No card required, 1 device, 1 project, 1 concurrent job.
- **Pro: US$7/month or US$59/year globally; ₹299/month or ₹2,499/year in India.**
- **Team: US$10/user/month globally (minimum 3); ₹699/user/month in India.**
- **Business: from US$299/month, quoted.** Larger deployments, procurement, advanced support and negotiated limits.
- **Planned trial (not active):** eligible new accounts may receive **14 days of Pro**, no card required, after the trial entitlement is production-tested. No automatic paid conversion unless the customer explicitly chooses a paid subscription.
- **Proposed founding-users offer (not active):** Pro annual at US$39 for the first 200 paying accounts in an announced window, price locked for 12 months, subject to taxes, abuse controls and published Terms. No founding price applies until the owner publishes actual checkout terms.

These prices exclude AI-model subscription or API fees charged by third-party AI providers.

## Proposed monthly remote tool-call limits (source-only, not active)

For KMJ-hosted remote MCP accounts, the **proposed** UTC-calendar-month allowance is **Community 10,000 calls (free)**, **Pro 100,000 calls at the existing ₹299/month India price**, **Team 300,000 calls per paid user at the existing ₹699/user/month India price**, and **Business custom**. These are **not currently enforced**, not currently purchasable, and are **not** model tokens or hosted LLM credits. The Apache-2.0 self-hosted core has **no KMJ remote monthly call ceiling**.

A future server-side usage ledger must count each device-delivered completed execution once (including a completed application error), not denied/replayed or transport-failed requests. Reset occurs at **00:00 UTC on day 1** each month, warnings start at **80%**, and quota exhaustion pauses new hosted execution without overage, forced upgrade or automatic AI charges. Signed tenant/seat entitlements, exact-once concurrency-safe accounting, an authenticated usage view, rollback and real device/browser evidence are required **before** activating this policy.

[Source-only monthly usage proposal and security acceptance →](HOSTED-MONTHLY-TOOL-CALL-PLAN-20261123.md)

**Pilot enquiries:** Developers who want an early access evaluation can [contact KMJ CodeBridge support](https://kmjtechno.com/products/kmj-codebridge/support) voluntarily. This is not a payment link. Only a KMJ Main Platform owner-authorized, independently verified commercial order may lead to a hosted paid entitlement.

## Feature matrix

| Capability                          | Community | Pro |  Team   | Business |
| ----------------------------------- | :-------: | :-: | :-----: | :------: |
| Open-source gateway + agent         |     ✓     |  ✓  |    ✓    |    ✓     |
| Outbound-only device connection     |     ✓     |  ✓  |    ✓    |    ✓     |
| Read / inspect / Git status         |     ✓     |  ✓  |    ✓    |    ✓     |
| Guarded file edits                  |     ✓     |  ✓  |    ✓    |    ✓     |
| Administrator-defined quality gates |     ✓     |  ✓  |    ✓    |    ✓     |
| Devices                             |     1     |  3  | 10/user |  Custom  |
| Projects                            |     1     | 10  | 50/user |  Custom  |
| Concurrent jobs                     |     1     |  3  | 10/user |  Custom  |
| Hosted account linking              |     —     |  ✓  |    ✓    |    ✓     |
| Signed commercial entitlement       |     —     |  ✓  |    ✓    |    ✓     |
| Extended job history                |     —     |  ✓  |    ✓    |    ✓     |
| Shared team policies                |     —     |  —  |    ✓    |    ✓     |
| Team administration                 |     —     |  —  |    ✓    |    ✓     |
| Audit export                        |     —     |  —  |    ✓    |    ✓     |
| SSO / enterprise identity           |     —     |  —  | Planned |    ✓     |
| Priority support                    |     —     |  —  |    ✓    |    ✓     |
| SLA / procurement terms             |     —     |  —  |    —    | Optional |

“Planned” means it must not be represented as generally available until CI-backed implementation and production rollout are complete.

## What stays open source

The Apache-2.0 licensed source remains usable for self-hosting and contribution. Paid plans do **not** remove Apache-2.0 rights from already-published source. Commercial plans monetize hosted onboarding, signed entitlements, managed operations, higher limits, team/enterprise controls, support and future proprietary service-side capabilities.

## Entitlement model

KMJ Main Platform is the commercial authority. Paid-only capabilities must be enforced by signed entitlements and server-side account policy, not merely hidden in the UI. A client-controlled agent must never be treated as the sole billing enforcement point.

Suggested entitlement identifiers:

- `community`
- `pro`
- `team`
- `business`

Suggested feature claims:

- `read`
- `write`
- `execute`
- `hosted_linking`
- `extended_history`
- `team_policy`
- `audit_export`
- `priority_support`

## Pricing principles

1. Keep a genuinely useful free tier to drive installs, stars and word of mouth.
2. Make the first paid step inexpensive enough for individual developers to try without procurement.
3. Never charge twice for third-party AI usage: CodeBridge pricing covers CodeBridge, not OpenAI/Anthropic/other model fees.
4. Display taxes, renewal price, cancellation and any regional differences before checkout.
5. Do not use fake countdowns, hidden auto-renewal or forced paid conversion after trial.
6. Change future prices prospectively with clear notice; do not retroactively alter already-paid periods.

See [Commercial Terms](COMMERCIAL-TERMS.md) and [Licensing](LICENSING.md).
