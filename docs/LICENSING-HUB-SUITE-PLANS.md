# KMJ Suite Plans on the Licensing Hub (proposal v2)

> **Status: proposal, not an offer.** Owner direction on 2026-11-13: prices as low as practical so many people use KMJ products, fast revenue, and the freedom to change plans at any time. Version 2 applies that after a research pass (sources at the end). The owner has not yet confirmed the numbers, so M0 "scope and budgets agreed" stays open. No checkout is live. This is not financial or legal advice.

## Goal

One KMJ account and one Licensing Hub (KMJ Main Platform) issue signed entitlements for every KMJ product. Each product keeps its own plans; a bundle gives a discount for holding several. Main Platform stays the sole commercial authority (see [Licensing](LICENSING.md)); agents only verify signed entitlements.

## Strategy: lowest friction, not lowest number

Research showed that the cheapest sticker price is not the fastest route to either users or money:

- **Free is what drives adoption.** Tailscale gives away a generous Personal plan and charges from US$8 per user for teams. Freemium converts a small share (dev tools roughly 2 to 4 percent); trials convert far more (about 18 percent without a card, about 49 percent with one). So: free forever for installs, a card-free 14-day Pro trial for conversion.
- **Very low prices backfire.** A US$9 plan tends to attract high-support, low-lifetime-value customers, and one founder who raised US$9 to US$49 saw churn fall. Fixed per-transaction fees also hurt: a merchant of record such as Paddle charges 5 percent plus US$0.50, which is about 12 percent of a US$7 sale and 25 percent of a US$2 sale.
- **Regional pricing is the right low-price tool.** Indian prices at 40 to 60 percent below the US price are common and widen the market without cutting the global price.

So v2 sets global prices at the low end of the peer range (not a toy price), makes India clearly cheaper, and keeps a hard floor of US$5 per month because of fees and support cost.

## Proposed plans (list prices, change at any time under the policy below)

### KMJ CodeBridge

| Plan      | Global price                 | India price                     | Limits                            |
| --------- | ---------------------------- | ------------------------------- | --------------------------------- |
| Community | Free forever                 | Free forever                    | 1 device, 1 project, 1 job        |
| Pro       | US$7/month or US$59/year     | INR 299/month or INR 2,499/year | 3 devices, 10 projects, 3 jobs    |
| Team      | US$10/user/month (minimum 3) | INR 699/user/month (minimum 3)  | 10 devices/user, shared policy    |
| Business  | From US$299/month, quoted    | Quoted                          | Custom limits, SSO, SLA (planned) |

Founding offer (limited to the first 200 paying accounts, announced window only): Pro annual at US$39, locked for 12 months. Annual prepayment brings cash in early. No lifetime licences for hosted features.

The free tier stays at 1 project because the agent enforces it today (`src/agent.js`); raising it needs a code change and a release.

### KMJ OmniDesk (remote access)

| Plan | Global price                | Notes                             |
| ---- | --------------------------- | --------------------------------- |
| Free | Free                        | Personal use, limited connections |
| Solo | US$5/month or US$49/year    | 1 user, up to 10 managed devices  |
| Team | US$9/user/month (minimum 3) | Address book, audit, 2FA          |

OmniDesk is priced just under RustDesk Pro's Individual plan (about US$9.90 per month on annual billing). Sell only once an installer and a working relay exist.

### KMJ Calibration Pro and KMJ CineCore (professional AV, direct sales)

High-value, low-volume products: licence per projector channel (Calibration Pro) or per screen (CineCore), annual subscription with maintenance, invoiced and issued through the Licensing Hub. VIOSO licenses per projector channel, and its prices are quote-only, so no competitor figure was found. Publish no numbers until two or three prospects have been quoted. Paid pilots (a fixed fee per site including onboarding) are the fastest realistic revenue and need no public checkout.

### KMJ Suite bundle

CodeBridge Pro plus OmniDesk Solo with 20 percent off while both stay active (US$9.60 per month instead of US$12). One account, one invoice.

### Not priced

KMJ CloudOS has open hosting-cost questions. The VIOSO-clone project is a clean-room clone of a third-party product and needs separate legal review before any commercial use.

## Changing plans at any time

Prices are data in the Licensing Hub, not code. To make that safe:

1. **Versioned plan catalogue.** Every plan has an id and a version (`codebridge.pro@2`). A subscription records the version it bought. Changing a price creates a new version; old versions stay readable for audit and refunds.
2. **Lowering or adding plans:** apply to new customers immediately; existing customers can be moved to the cheaper version on request or automatically at renewal.
3. **Raising prices:** only prospectively. Monthly plans get at least 30 days' notice; annual plans get 60 to 90 days, effective at the next renewal, never mid-term. [Commercial Terms](COMMERCIAL-TERMS.md) section 15 already allows prospective changes with notice.
4. **Grandfathering with a defined end.** For increases above roughly 15 to 20 percent, keep existing customers on their price for a stated period (for example until the second renewal). Do not promise "for life": it creates legal and operational problems.
5. **Founding prices** are a separate version with a stated lock period.
6. Entitlements are re-signed on every 24-hour lease, so a plan change reaches devices without a new release (see [Licensing](LICENSING.md)).

## Licensing Hub mapping

- Identifiers: `codebridge.community|pro|team|business`, `omnidesk.free|solo|team`, `calibration.channel`, `cinecore.screen`, `suite.bundle`, each with a version suffix.
- Trial: **14 days of Pro**, card-free, no automatic paid conversion. [Pricing](PRICING.md) says 30 days and should be aligned once the owner confirms.
- Leases renew every 24 hours with up to 48 hours grace; payment retries must not create duplicate licences (M3 acceptance).

## Payments (owner decision)

India customers: a gateway with UPI. Razorpay charges about 2 percent plus GST domestically and about 3 percent plus GST on international cards, versus roughly 6 percent all-in on Stripe for Indian businesses. A merchant of record (Paddle, Dodo) costs more per sale but handles global sales tax. Choose after comparing real quotes; the Hub should keep the payment provider behind an interface so it can be swapped.

## Fastest path to first revenue

1. **Paid pilots for Calibration Pro and CineCore** (invoice, no checkout).
2. **Founding annual offer for CodeBridge and OmniDesk** once checkout and the cancellation flow are tested (M5).
3. **Team plans** after the first Pro customers refer teammates.

## Owner prerequisites (Claude cannot do these)

- A payment provider account and tax or GST registration where required.
- Published refund, privacy and acceptable-use pages linked from checkout.
- Counsel review of [Commercial Terms](COMMERCIAL-TERMS.md) before paid launch.
- Owner approval of the numbers.

## What is not claimed

No revenue forecast: conversion, customer count and churn are unknown. Illustration only: 200 founding annual buyers at US$39 is US$7,800 gross before fees, taxes and support cost. The benchmarks above come from third-party summaries of mixed quality; treat them as directional and measure your own conversion.

## Sources (read 2026-11-13)

- Free-to-paid and trial conversion: ChartMogul 2026 survey summary at 1capture.io; knowledgelib.io benchmarks; First Page Sage 2026 report.
- Underpricing: Freemius micro-SaaS pricing guide; Monetizely articles.
- Tailscale plans: tailscale.com docs and Toolradar, CostBench.
- Regional pricing: Monetizely and Eximpe on India discounts.
- Plan changes: Recurly and Uscreen documentation; Monetizely grandfathering article.
- Payments: Skydo, Winvesta, Sprintzeal, Dodo Payments, CompareP.
- Peer prices: RealVNC on RustDesk; Morph and Dupple on Copilot and Cursor.
