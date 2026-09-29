# Delivery status

Version 0.1.0 is a developer preview. The full nine-phase roadmap is not complete.

| Area         | Implemented here                                                      | Still required                                                      |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| MCP          | Real official-SDK Streamable HTTP server and client integration tests | Actual ChatGPT connection against hosted endpoint                   |
| Devices      | Outbound agent transport and multi-device authorization mapping       | Enrollment UI, device-key identity, signed installers               |
| Coding       | Scoped reads/search, hash-checked writes, Git status, fixed gates     | Worktree orchestration, full language adapters                      |
| Jobs         | Local terminal results, idempotent starts, cancellation, timeouts     | Durable gateway queue, robust hard-crash orphan reconciliation      |
| Licensing    | Signed entitlement verifier and local replay/time checks              | Main Platform activation/renewal, billing, global limits/revocation |
| Platform     | Node.js portable source and Linux tests                               | Windows CI evidence, macOS and native Rust agent                    |
| Security     | Scope/auth/path checks and regression tests                           | OS isolation, OAuth, penetration testing, production approval       |
| Distribution | One plugin source and endpoint-driven packager                        | Hosted endpoint, authenticated install test, public review          |
| Revenue      | Proposed plans and rollout roadmap                                    | Live approved checkout, real customers and payments                 |

No generated local credentials are published. No production system is modified. No
cloud deployment or payment is claimed. Test counts and CI links are reported only
after actual runs; see the implementation ledger for observations.

## OAuth resource-server slice

Implemented optional JWT validation with pinned public JWKS, protected-resource metadata, scope challenges and administrator-controlled subject mapping. See [OAuth configuration](OAUTH.md). No live issuer, payment connection, lease renewal service or ChatGPT installation is claimed.
