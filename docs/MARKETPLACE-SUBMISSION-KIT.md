# KMJ CodeBridge — Marketplace submission kit

**Release:** 0.3.2, Apache-2.0 open-source core.

**Publisher:** KMJ TECHNO.

**State:** GitHub-hosted Claude marketplace source available; Glama publicly
indexed but owner claim incomplete. Other curated marketplaces need
authenticated submission, review or external publication evidence.

## Canonical references

- Repository / Claude marketplace: https://github.com/kmjtechno/kmj-codebridge
- Remote MCP connector: https://kmjtechno.com/mcp
- Product: https://kmjtechno.com/products/kmj-codebridge
- Support: https://kmjtechno.com/products/kmj-codebridge/support
- Privacy: https://kmjtechno.com/products/kmj-codebridge/privacy
- Terms: https://kmjtechno.com/products/kmj-codebridge/terms
- Existing Glama listing: https://glama.ai/mcp/servers/kmjtechno/kmj-codebridge/schema
- Owner-controlled MCP Registry workflow:
  https://github.com/kmjtechno/kmj-codebridge/actions/workflows/publish-mcp-registry.yml

## Copy-ready public listing

**Name:** KMJ CodeBridge

**Headline:** Your AI, the right project — not your entire server.

**Short description:** Secure, project-scoped MCP coding for authorized
computers and VPSs, using outbound device agents, guarded file changes
and administrator-approved quality gates.

**Description:** KMJ CodeBridge is an open-source-core, OAuth-protected
Model Context Protocol bridge connecting compatible AI clients to
projects on authorized workstations and VPSs. Administrators approve
device identities, project roots, permissions and verification gates.
An outbound device agent avoids the need for a public inbound shell.
Bounded reads, guarded edits, Git inspection and configured quality
gates support reviewable software-engineering workflows. Hosted
commercial plans are separate from the open-source core, and depend on
verified production onboarding and the actual order terms.

**Categories:** Developer tools, MCP, remote coding, DevOps, secure
automation, Git, AI coding, VPS, remote workstations.

**Integration paths:** Claude Code, compatible Claude Desktop and
Claude.ai clients, ChatGPT, and Streamable HTTP MCP-compatible clients.
Actual client functionality and supported permissions vary.

Use official KMJ branding from `plugin/assets/icon.png`. Never invent
user counts, benchmarks, screenshots, reviews or marketplace approvals.

## Reviewer-safe proof

A publisher-approved sample account must have only disposable devices
and projects. An authorized reviewer should:

1. Sign in through the actual OAuth authorization flow.
2. List the demo account's single approved device and project.
3. Read a harmless test file inside the authorized project root.
4. Confirm a path outside the root is rejected.
5. With separate write approval, make a hash-guarded test file edit.
6. Run a configured harmless gate and revoke the demonstration device.

Do not expose production credentials or customer repositories to
directory reviewers. Record only actual evidence from the live server.

## Revenue and conversion

The repository describes **Community**, **Pro**, **Team** and **Business**
launch plans in `docs/PRICING.md`. These are not proof of an active
paid checkout. Taxes, renewals, subscriptions, availability and any
third-party model charges must be disclosed in the actual order terms.

Main Platform's documented **live charging is OFF**. Its shortest
approved route for an eligible customer is the governed manual sales
lane, not an invented payment button:

- Activate only a supported commercial product through owner authority.
- Collect an authorized purchase request with agreed terms.
- Receive payment through a separately approved compliant method.
- Verify actual payment and record the confirmed commercial order.
- Fulfill an entitlement and product-native license only where
  supported and after independent payment verification.
- Verify that customer onboarding and activation actually work.

The source of truth is
https://github.com/kmjtechno/kmj-main-platform/blob/main/docs/revenue/MANUAL_SALES_EARNING_LANE.md.

## Prioritized external submissions

- **P0 — MCP Registry:** Approve protected main-branch Environment,
  verify live OAuth, then manually run GitHub OIDC publication workflow.
  State: `SOURCE_READY`, not externally published.
- **P0 — Anthropic directory:** Sign in through the paid Claude
  publisher portal and submit the GitHub plugin bundle with reviewer
  account. State: `BLOCKED_AUTHORIZATION`.
- **P0 — Smithery:** Authenticate KMJ-controlled publisher namespace,
  submit the canonical remote MCP URL and verify discoverability.
  State: `BLOCKED_AUTHORIZATION`.
- **P0 — Glama:** Claim the already indexed GitHub listing and prove
  the real tools work. Avoid duplicate submissions.
  State: `INDEXED_UNCLAIMED`.
- **P1 — OpenAI directory:** Complete organization/domain verification,
  secure reviewer login, demonstrations and app review.
  State: `BLOCKED_AUTHORIZATION`.
- **P1 — GitHub Releases:** Require signed artifacts, verified installs
  and rollback evidence before promising an installable stable release.
  State: `RELEASE_GATE`.
- **P2 — VS Code, Open VSX and JetBrains:** Build and validate actual
  client-native extensions before submitting.
  State: `NATIVE_EXTENSION_NOT_READY`.
- **P2 — MCP.so, PulseMCP and other catalogs:** Check existing
  indexing, then submit one genuine entry under each provider's rules.
  State: `NOT_SUBMITTED`.

Track actual authenticated installations, value events and completed,
fulfilled paid orders. A listing or green source CI is not revenue.
Keep reviewer and publisher credentials outside Git, ZIPs and chat.
