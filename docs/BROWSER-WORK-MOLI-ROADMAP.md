# KMJ CodeBridge — Moli-backed browser Work workflows

Status: **Stage 0 PREVIEW ONLY, NOT DEPLOYED, NO USER SESSION**.

## Existing pieces

- Pinned Moli 1.1.18 binary and `browser_fast_probe` are implemented for
  anonymous, fixed `kmj_public` URLs.
- Chrome `browser_qa_start` is public-only; it does not click or authenticate.
- Upstream Moli supports WebDriver/CDP/BiDi, `moli serve`, Playwright CDP
  and programmatic DOM interactions. Upstream capability != CodeBridge rollout.
- Dirty Windows P720 checkout and the main production agent stay untouched.

## New Stage 0 — minimal safe contract

`browser_workflow_preflight({device,project,workflow:"brevo_domain_auth"})`
only works for authorized `kmj-main-platform`, returns a deterministic
non-executing plan and safety gates; no browser launch, account session,
DNS or mail writes. It never accepts arbitrary URL, JS, cookies, OTP, credentials,
payment method or model-produced action code.

The fixed proposed workflow is Brevo Free account/plan read, isolated owner
sign-in, review sender-domain records for `kmjtechno.com`, explicit owner
approval for registration and Cloudflare record edits, private SMTP activation,
then one consensual real inbox test. Paid-plan upgrade is always excluded.

## Stage 1 — browser/identity security (NOT IMPLEMENTED)

- Administrator enrolls one browser-work capable device with explicit project
  grant and attaches a user-approved **separate** encrypted session/profile.
- Use loopback-only Moli CDP endpoint (or locally installed Chrome fallback);
  never publish a debugging TCP port or reuse a logged-in default profile.
- Site-origin allowlist and full redirect/request/interstitial checks enforce
  public HTTPS domains only; disallow loopback, link-local, metadata IPs, DNS
  rebinding, file/data/blob/javascript URLs, open redirects and private IPs.
- MCP interface requires bounded, typed actions rather than arbitrary scripts.
  Stable job IDs, checkpoints, cancel, screenshots redacted, no secret logs.
- HITL approval every time before provider account mutation, DNS, payment,
  message sending, inviting people, or irreversible settings.
- Manual MFA/OTP/passkey completion; no bypass or capture of recovery codes.

## Stage 2 — implementation (NOT IMPLEMENTED)

- Chrome/Moli CDP compatibility tests with real authenticated _test accounts_.
- Brevo pages inspected after owner-controlled login: Free plan, sender domain,
  DNS verification. Never fabricate DNS values; read them from Brevo.
- Cloudflare change preview with exact record IDs, no MX/A/nameserver changes,
  then explicit per-record approval and post-change readback.
- Secret store binding and test mail acceptance / actual inbox verification.
  Signed URL must verify correct KMJ customer and not allow enumerating users.
- Domain owner can revoke all sessions; rollback and an auditable event trail.
- Additional websites onboarded via explicit policy and tests, not universal
  default browser access. Every operation remains within plan entitlements.

## Release gates

Stage 0: `node --test tests/browser-workflow-preflight.test.js`,
`npm run check`, `npm test`, `npm run scan:secrets`, exact-head CI.
Then approved rollout of CodeBridge gateway/agent and live tool advertisement.
Do not confuse green GitHub CI or this plan with a deployed Web Work mode.

Stage 1/2 require an authenticated test run, owner-approved actions and
independent security review before enabling a Brevo/Cloudflare production task.
No additional paid subscription is requested.
