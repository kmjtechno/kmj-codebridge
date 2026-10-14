# KMJ CodeBridge — competitive plans and activation criteria

**As of 14 October 2026.** This is a truthful comparison and a proposed release contract, **not** evidence that hosted subscriptions, a 30-day trial or live checkout are available.

## Public comparison baseline

Desktop Commander's [official pricing](https://desktopcommander.app/pricing/) currently describes a free remote plan with up to 10,000 tool calls/month and a $20/month Pro plan with unlimited tool calls. It separately offers an open-source local MCP server. Product pages and actual entitlements can change: recheck both plans before marketing claims.

KMJ CodeBridge is **not a drop-in feature-complete replacement for Desktop Commander**. Its emphasis is authorized remote engineering over approved project roots, guarded edits, predefined quality gates, recorded status and outbound device agents. It does not grant arbitrary shell or full-device browsing. The separate user-selected AI model/API subscription is **not included** in CodeBridge hosted pricing.

## Proposed KMJ plans — no paid checkout yet

| Plan        | Proposed public price                                    | Intended scope                                                                            | State                                                       |
| ----------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Community   | Free forever                                             | Open-source core, 1 device, 1 project, 1 concurrent job                                   | Self-hosted core exists; hosted activation must be verified |
| Pro Launch  | ₹149/month (India) / US$1.99/month (elsewhere)           | 3 devices, 10 projects, 3 concurrent jobs, managed conveniences                           | Planned; not charged                                        |
| Team Launch | ₹399/user/month (India) / US$4.99/user/month (elsewhere) | 10 devices/user, 50 projects/user, 10 jobs/user, organization workflows                   | Planned; not charged                                        |
| Business    | Individual quote                                         | Custom authorized fleet limits, procurement/support, separately agreed service conditions | Planned; owner review                                       |

The planned **30-day Pro trial** and founding-user price protection are not active. Paid features are a hosted service/entitlement and cannot take away rights already granted by Apache-2.0. Do not market “unlimited cloud calls,” free third-party AI inference, guaranteed uptime, or services not implemented and verified.

## Three-friction onboarding target (not yet certified)

1. **Choose AI client:** Claude Code/GitHub Copilot CLI via self-hosted marketplace, Cursor or VS Code deep link, Codex or ChatGPT via remote MCP URL.
2. **Sign in and consent:** use KMJ Main Platform OAuth, select the KMJ account/organization, review explicit scopes and approve a specific device.
3. **Choose approved project:** start read-only, confirm one authorized project, then explicitly enable guarded writes and configured tests.

**Already verified in source:** Client manifests; generated plugin packages; Streamable HTTP remote endpoint and OAuth discovery; CI tests; GitHub/Gateway source. **Not yet verified end-to-end for a fresh paying customer:** editor-by-editor OAuth callback, one-click fresh device enrollment, subscription checkout/capture, secure licensing, renewals/revocation, international merchant capability and refund settlement.

## Razorpay + Cashfree “one-click checkout” release gate

The account owner reports merchant approval for both processors; this is **not** a verified live API integration. KMJ Main Platform is the sole payment/licensing authority. Only its owner-protected server may create exact-amount provider orders and bind them to commercial orders.

Required before any public **Buy** or **Start paid trial** button:

1. Sandbox credentials stored encrypted and write-only through `/operator/payments`; never paste keys into chat, Git or the AI client.
2. Independently verified Razorpay and Cashfree sandbox order, checkout, raw-body HMAC webhook, provider API capture/settlement and idempotent event inbox.
3. Customer/org/order/amount/currency/provider/merchant-environment match; replay and cross-tenant denials.
4. Completed refund/chargeback/cancellation/renewal workflows, explicit consent, tax and pricing disclosures.
5. Signed entitlements issued only after payment verification; atomic rollback and revocation on reversal; actual staging tests and independent live canary.
6. Owner approval for provider/country/currency after actual merchant-side international acceptance evidence, not just a claimed approved account.

An approved test-key connection is **not authorization** to charge users. A failed or pending processor attempt cannot silently fall back to another gateway on the same order. Processing fees and applicable taxes are separate from zero-cost development.

## Ethical launch loop

Publish one genuinely useful technical installation guide and security explanation; allow opt-in developer previews, actual bug reports, GitHub stars and customer testimonials only when voluntary. Track real first-device activation, authorized project inspection, verified quality gates, qualified pilot leads, paid orders after validation, and churn. Never automatically instruct models to advertise CodeBridge, fabricate reviews, scrape prospects or spam communities.

See [AI client quick start](AI-CLIENT-QUICKSTART.md), [current launch plans](PRICING.md), and [main-platform payment authority](https://github.com/kmjtechno/kmj-main-platform/blob/main/docs/payments/INTERNATIONAL_MULTI_GATEWAY.md).
