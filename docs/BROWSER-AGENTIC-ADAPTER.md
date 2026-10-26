# KMJ CodeBridge: guarded Browsentic observer (opt-in)

Release candidate, not a claim of installed, paired or production-ready interactive QA.

CodeBridge keeps two proven/isolated lanes: Moli v1.1.18 for bounded anonymous
public extraction and Chrome/Edge CDP with isolated profiles for visual QA.
Browsentic is a third, **optional** local owner-session observer: it cannot
replace either lane and never supplies screenshot-based release approval.

## First milestone: real browser read-only inspection

CodeBridge exposes browser_agentic_observe on an already authorized writable
kmj-main-platform project, subject to the ordinary execute entitlement and
the existing bounded one-slot job runner. The caller supplies only the fixed
kmj_owner_browser target and an idempotent requestKey, not URLs or actions.

When configured and locally paired, the agent starts an exact-SHA-pinned
Browsentic v0.9.0 local CLI over stdio MCP. It invokes exactly two read tools:
browsentic_status, then page_getPageInfo. An initial and final exact URL must
match and be in the fixed HTTPS kmjtechno.com public/admin route allowlist.
Any missing URL, unexpected redirect/tab switch, malformed payload, unpaired
extension, unsupported Windows behavior or failed package hash closes the
run with FAIL. A successful result contains only coarse counts of buttons,
links, fields and forms. No names, raw HTML, page text, screenshots, network
bodies, tokens, cookies, browser profiles or user credentials reach the
CodeBridge caller. This is OBSERVATION_ONLY, NOT a visual or functional PASS.

## Operator-controlled installation / consent

1. Review Browsentic upstream Apache-2.0 source, releases and dependency
   artifacts, including Windows experimental limitations and its local
   same-OS-user permission boundary. Do not use curl|sh, iex or @latest.
2. Install the exact reviewed v0.9.0 npm package in an isolated fixed path:
   Linux: /opt/kmj-codebridge-tools/browsentic/v0.9.0/node_modules/browsentic/
   Windows: C:\ProgramData\KMJ\CodeBridge\browsentic\v0.9.0\node_modules\browsentic/
   Inspect all directory ACLs, reject symlinks and record installation provenance.
   No automatic package installation is added to CodeBridge.
3. The local CodeBridge agent must run under a user with an explicitly
   approved, paired Browsentic browser extension. Never copy owner browser
   profiles/cookies into a server service account or bypass pairing.
4. After a real reviewed install, calculate SHA-256 of dist/cli.js and opt in
   through the agent configuration:
   browserAgentic: { enabled: true, entrySha256: "<exact lowercase SHA-256>" }
   This is default-off; the command refuses execution without both fields.
5. Smoke browser_runtime_status and browser_agentic_observe on the enrolled
   owner device. Confirm actual MCP pairing, route pin, filtered result,
   denial tests, timeout, negative cases, and operator revocation.

No production switch should occur before SHA-bound CI, exact-release agent
update, rollback evidence and authenticated owner browser QA. The current
implementation does NOT automate logins, clicks, form submission, payments,
captcha bypass or deployment. Introducing any of those requires a separate
explicit Main Platform permission and origin/action-policy security review.

## What is deliberately not imported

Browsentic's entire set of 52 tools, side-panel AI CLI spawn, arbitrary URL
navigation, upload/download, captcha actions, injected JavaScript, remote
debugging interfaces and unattended write override are not exposed to
CodeBridge. None is safe to silently inherit from a third-party MCP bridge.
Keep CodeBridge's working Chromium/Moli engines; there is no evidence they
are redundant. Only remove a proven dead path after real usage/rollback audit.
