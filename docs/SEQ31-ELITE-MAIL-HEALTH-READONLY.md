# Seq31 source-only: KMJ-elite mail health read tool

**Status: SOURCE ONLY / OWNER REVIEW REQUIRED.** No runtime signing, privileged
deployment, permission grant, remote activation or production change has occurred.
This feature adds visibility into privileged mail-queue metadata, so its new
read scope requires owner security review before merge or signed cutover.

## Contract

- Direct MCP read tool: `supervisor_main_platform_mail_health`.
- Strict scope: device `kmj-elite-main-platform`, project `kmj-main-platform`,
  writable project registration and existing `read` access grant.
- Fixed root Supervisor RPC `{"op":"main_platform_mail_health"}`, with no
  caller-selected executable, argv, path, environment, shell or log scope.
- Existing root Supervisor (default/production profile only) reads:
  - `/usr/sbin/postqueue -j`, bounded to 256 KiB and 5 seconds.
  - `/usr/sbin/postconf -h maximal_queue_lifetime`, `relayhost`,
    `smtp_fallback_relay`.
  - Fixed `systemctl show postfix.service/opendkim.service` ActiveState.
- Pure parser outputs only queue message/recipient counts, service boolean
  states, route booleans, historical SMTP code *categories*, age buckets and
  bounded uptime/lifetime fields. **Never returns SMTP response strings,
  email addresses, queue identifiers, envelope senders, recipient addresses,
  message headers, bodies, credentials or raw journal.**
- A second gateway-side allowlist reconstructs every response field. Unexpected
  privileged fields cannot propagate to connected clients.
- Parser errors / too-large queues → `inspection=UNAVAILABLE`,
  `queueDrained=null`, never a fabricated `0`.
- Queue drained is never recipient inbox delivered:
  `recipientDeliveryProven=false` unconditionally.

## Owner-locked mail architecture

Incoming `info@kmjtechno.com` stays on Cloudflare Email Routing; outbound
Laravel `sendmail` → existing Elite Postfix direct MX primary; Brevo is
`smtp_fallback_relay` **only**, OpenDKIM existing. No Google VPS. The fixed
tool is read only and will **never** send an email, retry or purge a queue,
change credentials, restart services, modify the domain or promote a release.

## Acceptance gates

1. Exact HEAD Node tests and `npm run check` must pass.
2. Independent threat review: no argv/path injection, wrong device/project
   rejected, no PII even if privileged handler is injected with extra data,
   malformed/oversized queue fails closed, zero queue never claims delivery.
3. Owner explicitly reviews any expansion of root Supervisor read authority.
   Do not auto-merge solely because source-only test checks are green.
4. Separate owner-signed root Supervisor and gateway release at a pinned SHA
   with existing rollback, socket ACL and device-grant preflight.
5. Only after verified installation can ChatGPT call this as a **live** tool.
   Source PR/merge alone is never a live authorization receipt.

## P0 limitations

Postfix queue counts are **not** receipt evidence. A separate, privacy-safe
sent/bounced/expired reconciliation and one owner-approved real Laravel email
verification plus password reset signed-link inbox test remain required.
Reference Main Platform issue #391 and merged mail architecture PR #955.
