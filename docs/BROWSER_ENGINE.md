# KMJ CodeBridge: Local-First Browser Architecture

## Decision (October 2026)

Do not build a new general-purpose browser or host a browser per customer on KMJ's VPS. Execute bounded browser work locally on the explicitly authorized CodeBridge device under the existing scoped job runner. CodeBridge Main Platform remains the customer identity and device authorization authority, not GitHub.

| Workload | Preferred runtime | Status |
| --- | --- | --- |
| Anonymous semantic extraction of fixed public KMJ pages | Existing separately pinned Moli 1.1.18 | Implemented, bounded receipt |
| Fixed public site screenshot, JS, viewport and layout QA | Local Chrome/Edge Chromium CDP pipe | Implemented, 9 screenshot hashes |
| Browser runtime readiness and cross-platform discovery | Native CodeBridge MCP `browser_runtime_status` | This change |
| Authorized form/click workflows across approved sites | Local `playwright-core` with site/action grants | Planned; **not implemented** |
| AI-assisted page interaction | Optional planner over deterministic local Playwright actions | Research; no unrestricted model commands |
| Lightpanda as a Chrome replacement | Not recommended as default while beta | No silent fallback or performance claim |

Moli advertises lower resource consumption for many AI workloads, but is not pixel-for-pixel Chrome-compatible. Lightpanda's upstream describes it as beta. Only same-hardware, same-network repeatable benchmarks can establish CodeBridge-specific speed/reliability, so do not claim a winner based on third-party promotional numbers.

Primary research:
- [Moli (Rust; CDP/CLI/WebDriver; official benchmarks and compatibility caveats)](https://github.com/lexmount/moli)
- [Playwright browsers and cross-engine testing](https://playwright.dev/docs/browsers)
- [Official Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Lightpanda beta limitations](https://github.com/lightpanda-io/browser)
- [Browser Use](https://github.com/browser-use/browser-use)
- [Stagehand Playwright integration](https://github.com/browserbase/stagehand)

## Security and cost contract

- **Local-first:** Chrome and Moli run on the customer's approved agent; no KMJ-hosted per-customer browser sessions, cookies, screenshots or costly third-party browser APIs.
- **Deterministic work:** The currently implemented browser tools accept only fixed `kmj_public` target paths, never user-supplied URLs, scripts, browser profiles, credentials or unrestricted shell commands.
- **Engine choice:** Prefer separately pinned installed Moli for bounded anonymous public text extraction. On failure run established Chromium fidelity QA; an extraction PASS is never considered full visual QA. Always use Chromium for real screenshot/layout fidelity.
- **Isolation:** Chromium runs under an ephemeral private HOME/profile/cache/temp directory using a debugging **pipe**, not a public debugging port. The child receives only a short OS bootstrap-variable allowlist. Agent API keys, CodeBridge credentials, parent proxy variables, storage and user cookies are not inherited.
- **No unsafe shortcuts:** Do not disable Chrome sandbox, run root Chrome, fetch arbitrary browser binaries, follow symlink executables or silently reuse customer personal profiles.
- **Evidence:** Existing JobRunner limits resource/concurrency/time; tools return secret-free receipt hashes, not raw HTML or screenshots. Browser availability probes do not launch a browser or contact the cloud.
- **Availability:** A local installed binary is only a readiness hint, not a guarantee of successful page load, Web APIs, network access, authentication or Chromium compatibility.

## Next milestone: Guarded interactive Playwright driver

To support websites other than the current fixed public QA sites, implement a **separate optional** local-only driver with an action schema and safety approvals. It must not expose unrestricted `@playwright/mcp` or page JavaScript evaluation to arbitrary cloud chat callers.

P0 gates before release:

1. Customer selects authorized project, HTTPS origins, approved actions, local browser lifetime and separately approves login/submit/download.
2. Enforce network origin and DNS/IP policy on all requests and redirects, including subrequests. CDP URL allowlists alone are not a security boundary. Block private/link-local/loopback/metadata access unless a separately approved local-development scope exists.
3. Run under OS sandboxing with ephemeral profile and restricted filesystem/network/CPU/RAM; no persistent cookies or user profile import.
4. Bind every tool call to Main Platform OAuth, tenant/project grants and the CodeBridge job queue. Require user confirmation for irreversible effects, spending, external messages and account changes.
5. Keep logs/screenshots bounded, local and redacted, with operation receipts; no private HTML, storage state or cookies in default MCP responses.
6. Run actual Windows/Linux/macOS CI and representative Chromium/Firefox/WebKit browser smoke, malicious redirects, SSRF, file/data URLs, timeouts, invalid grants, crash and recovery tests.
7. Benchmark Moli vs Chromium vs Playwright on the same hardware: cold/warm start p50/p95, success rates, memory, CPU, browser-page complexity, parallel sessions and bytes sent to the KMJ server.

No performance, million-user scale or full-site compatibility claims until those gates pass.
