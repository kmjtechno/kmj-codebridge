# KMJ Suite Plans on the Licensing Hub (proposal)

> **Status: proposal, not an offer.** Owner delegated plan design on 2026-11-13 ("jo bhi best ho aur jaldi earning karwane ke liye best ho"). The owner has not yet confirmed the numbers below, so M0 "scope and budgets agreed" stays open. No checkout is live; nothing here is a price anyone can pay today. This is not financial or legal advice.

## Goal

One KMJ account and one Licensing Hub (KMJ Main Platform) issue signed entitlements for every KMJ product. Each product keeps its own plans; a bundle gives a discount for holding several. Main Platform stays the sole commercial authority (see [Licensing](LICENSING.md)); agents only verify signed entitlements.

## Why the current launch prices should change

The current [launch plans](PRICING.md) are Pro US$1.99 and Team US$4.99 per user. Public list prices checked on 2026-11-13 are much higher:

- GitHub Copilot Pro is US$10/month, Business US$19/user/month; Cursor Pro is US$20/month.
- RustDesk Pro (remote access, the closest peer to OmniDesk) is about US$9.90 to US$11.88/month on annual billing; AnyDesk starts near US$28.90/month.

At US$1.99 the payment-provider fee, tax handling and support time eat most of each sale, and the low price signals a hobby tool. A paying developer compares against US$10, not US$2. Recommended: raise list prices to the peer range, keep Community free for installs, and use time-limited founding discounts (not a permanently low price) to create early sales.

## Proposed plans (list prices, validate before publishing)

### KMJ CodeBridge (self-serve developer tool)

| Plan      | Global price                 | India price                      | Limits                            |
| --------- | ---------------------------- | -------------------------------- | --------------------------------- |
| Community | Free                         | Free                             | 1 device, 1 project, 1 job        |
| Pro       | US$9/month or US$79/year     | INR 499/month or INR 3,999/year  | 3 devices, 10 projects, 3 jobs    |
| Team      | US$15/user/month (minimum 3) | INR 1,199/user/month (minimum 3) | 10 devices/user, shared policy    |
| Business  | From US$499/month, quoted    | Quoted                           | Custom limits, SSO, SLA (planned) |

Founding offer (limited seats, announced window only): Pro annual at US$49 for the first 100 paying accounts, price locked for 12 months. Annual prepayment brings cash in up front and lowers churn. No lifetime licences for hosted features: they create open-ended support cost.

### KMJ OmniDesk (remote access)

| Plan | Global price                 | Notes                             |
| ---- | ---------------------------- | --------------------------------- |
| Free | Free                         | Personal use, limited connections |
| Solo | US$7/month or US$59/year     | 1 user, up to 10 managed devices  |
| Team | US$12/user/month (minimum 3) | Address book, audit, 2FA          |

Price only once an installer and a working relay exist; do not sell a roadmap.

### KMJ Calibration Pro and KMJ CineCore (professional AV, direct sales)

These are high-value, low-volume products. Self-serve micro-subscriptions do not suit them. Proposed model: licence per projector channel (Calibration Pro) or per screen (CineCore), annual subscription with maintenance, issued by the owner through the Licensing Hub after an invoice. VIOSO documents per-projector channel licensing, which buyers in this market already understand. VIOSO list prices are quote-only, so no competitor figure was found.

| Product         | Unit              | Starting hypothesis (validate with real quotes)        |
| --------------- | ----------------- | ------------------------------------------------------ |
| Calibration Pro | Projector channel | Annual per-channel price plus paid onboarding per site |
| CineCore        | Screen            | Annual per-screen price plus paid installation support |

Do not publish numbers for these two until two or three prospects have been quoted and their reaction recorded. Paid pilots (a fixed fee per site that includes onboarding) are the fastest realistic revenue: they need no public checkout, only an invoice and a signed entitlement.

### KMJ Suite bundle

Customers holding CodeBridge Pro plus OmniDesk Solo get 20% off both while both stay active (about US$12.80/month instead of US$16). One account, one invoice.

### Not priced

KMJ CloudOS is hosted infrastructure with open cost questions. The VIOSO-clone project is a clean-room clone of a third-party product and needs a separate legal review before any commercial use; it is out of scope here.

## Licensing Hub mapping

- Entitlement identifiers: `codebridge.community|pro|team|business`, `omnidesk.free|solo|team`, `calibration.channel`, `cinecore.screen`, `suite.bundle`.
- Feature and limit claims follow the signed JWS envelope in [Licensing](LICENSING.md). Limits are enforced by the Hub and the gateway, not only the local agent.
- Trial: **14 days of Pro**, no automatic paid conversion. This matches the roadmap and [Licensing](LICENSING.md); [Pricing](PRICING.md) currently says 30 days and should be aligned once the owner confirms.
- Leases renew every 24 hours with up to 48 hours grace, so a Hub outage never blocks a paying customer's work.
- Payment retries must not create duplicate licences (M3 acceptance).

## Fastest path to first revenue (in order)

1. **Paid pilots for Calibration Pro and CineCore:** direct outreach to AV integrators and cinema operators; invoice per site; owner issues signed entitlements. No public checkout needed.
2. **Founding annual offer for CodeBridge and OmniDesk:** needs live checkout and a tested purchase and cancellation flow (M5.d1, M5.accept).
3. **Team plans:** after two or three Pro customers can refer teammates.

## Owner prerequisites (Claude cannot do these)

- A payment provider account that supports India and global cards, and tax or GST registration where required.
- Published refund, privacy and acceptable-use pages (linked from checkout).
- Counsel review of [Commercial Terms](COMMERCIAL-TERMS.md) before paid launch.
- Owner approval of the final numbers. Reply with the plan names and prices you accept, or changes.

## What is not claimed

No revenue forecast is given: conversion rate, customer count and churn are unknown and would be invented. Illustration only: 100 founding annual buyers at US$49 is US$4,900 gross before payment fees, taxes and support cost.
