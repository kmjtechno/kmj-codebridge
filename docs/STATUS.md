# Delivery status

Version 0.1.0 is a developer preview. The full nine-phase roadmap is not complete.

| Area         | Implemented here                                                        | Still required                                                             |
| ------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| MCP          | Real official-SDK Streamable HTTP server and client integration tests   | Actual ChatGPT and Claude connections against hosted endpoint              |
| AI clients   | One tool contract/skill; OpenAI and Claude Code packages; interop tests | Hosted OAuth for Claude.ai/Desktop and ChatGPT; live client sessions       |
| Devices      | Outbound agent transport and multi-device authorization mapping         | Enrollment UI, device-key identity, signed installers                      |
| Coding       | Scoped reads/search, hash-checked writes, Git status, fixed gates       | Worktree orchestration, full language adapters                             |
| Jobs         | Local terminal results, idempotent starts, cancellation, timeouts       | Durable gateway queue, robust hard-crash orphan reconciliation             |
| Licensing    | Signed entitlement verifier and local replay/time checks                | Live Main Platform activation/renewal, billing, global limits/revocation   |
| Platform     | Node.js source, Linux and Windows CI                                    | macOS verification and native Rust agent                                   |
| Security     | Scope/auth/path checks and regression tests                             | OS isolation, live OAuth linking, penetration testing, production approval |
| Distribution | One plugin source; OpenAI and Claude Code packagers; credential scan    | Hosted endpoint, authenticated install test, public review                 |
| Revenue      | Proposed plans and rollout roadmap                                      | Live approved checkout, real customers and payments                        |

No generated local credentials are published. No production system is modified. No
cloud deployment or payment is claimed. Test counts and CI links are reported only
after actual runs; see the implementation ledger for observations.

## OAuth resource-server slice

Implemented optional JWT validation with pinned public JWKS, protected-resource metadata, scope challenges and administrator-controlled subject mapping. See [OAuth configuration](OAUTH.md). No live issuer, payment connection, lease renewal service or ChatGPT installation is claimed.

## Multi-client MCP slice (ChatGPT + Claude)

CodeBridge is now packaged as a vendor-neutral MCP bridge. ChatGPT and Claude
clients share one gateway, tool contract, skill and security model; see
[AI client support](CLIENTS.md). Added: tool titles, RFC 9728 path-suffixed
protected-resource metadata, a configurable device timeout, isolated OpenAI `_meta`
extensions, a Claude Code plugin/marketplace packager, a repository and package
credential scan, and vendor-neutral MCP interoperability contract tests with
dedicated CI jobs.

Verified in the development workspace: the generated Claude Code marketplace and
plugins pass `claude plugin validate --strict` (Claude Code 2.1.285) and install
into an isolated Claude Code configuration with one skill and one MCP server.
In CI (Node 24, real MCP SDK) the vendor-neutral interoperability contract passes
11/11 and the full Linux and Windows suites pass; the `clients` job also runs the
official Claude Code plugin validator as an enforced gate. Not verified: any live
Claude.ai, Claude Desktop, Claude Code or ChatGPT session against a hosted gateway,
and any authorization server. Claude.ai and Claude Desktop remain unavailable until a public HTTPS
endpoint and OAuth authorization server exist.

## Milestone accounting

No full M0–M8 phase has all its acceptance gates verified yet: **0/9 fully accepted
phases**. This is a release-gate count, not a claim that no code has been written.
M0–M4 have partial engineering work; M5–M8 remain future work. A defensible overall
percentage needs weighted, agreed deliverables; test counts are not a completion
percentage. The current product is an executable developer preview.

The optional signed renewal client now has transport and agent cache lifecycle tests.
Live Main Platform contract interoperability and deployed account linking are still
blocked on real service configuration, credentials and endpoints. No permanent cloud
hosting has been provisioned by this development workspace.
