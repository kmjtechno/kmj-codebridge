# Delivery status

Version 0.3.2 is a developer preview moving through production integration. This
file records verified capability, not a percentage-complete claim.

## Verified now

- **MCP core:** official SDK Streamable HTTP gateway, bounded tool contract,
  tenant/device/project authorization, guarded writes, jobs, and interop tests.
- **Public endpoint:** `https://kmjtechno.com/mcp` is the production MCP
  resource used by current client setup.
- **OAuth:** protected-resource discovery and KMJ account authorization work in
  a real Claude Code OAuth session and a Claude web custom connector.
- **ChatGPT:** the connected KMJ CodeBridge tool surface is callable from the
  current ChatGPT integration; device availability remains independent.
- **Claude Code:** real OAuth login completed against the hosted endpoint;
  repository package validation remains enforced in CI.
- **Claude web:** custom connector added by URL, authenticated, and exposed the
  CodeBridge tool permissions.
- **Claude Desktop:** normal-account mode uses the hosted endpoint. A
  third-party inference Gateway profile was verified end-to-end through
  Inference configuration → Connectors: OAuth completed with a public PKCE
  client using an RFC 8252 loopback callback, and Claude then inspected the
  authorized writable CodeBridge project through the live connector.
- **Devices:** outbound agent, dynamic device introspection, verifier-bound
  pairing client, hardened systemd service, and restricted socket-activated
  Supervisor are implemented.
- **Crash recovery:** the agent state lock now recovers automatically only when
  staleness is provable; exact-head Linux, Windows, client, and distribution CI
  passed before merge.
- **Low-load poll path:** successful work re-polls immediately, idle long-poll wait is
  bounded/configurable, and connection-state persistence is transition-only. A
  post-P5 120-second VPS sample measured agent CPU 0.291%, gateway CPU 0.350%,
  combined RSS 173.4 MB, and /healthz 65.007 ms. These are process/liveness
  measurements, not a full authenticated MCP round-trip benchmark.
- **Main Platform:** source contains CodeBridge OAuth/OIDC, device pairing and
  redemption, user/device introspection, entitlement/renewal services, account
  UI, and regression tests.
- **Updates:** signed immutable release verification, DNS-pinned/no-redirect
  metadata and archive download, exact size/hash enforcement, safe runtime
  extraction, atomic activation/rollback, root-isolated anti-rollback state,
  production dependency preflight, fixed Supervisor restart, signed-runtime
  identity health checks, and mutually exclusive development/stable systemd
  timers are implemented. Stable/beta mode requires explicit root-owned public
  trust anchors and a root-owned updater config; the agent switches through the
  immutable signed `current` runtime with bootstrap fallback. Publishing a real
  signed stable release and observing live activation plus rollback remain
  separate production-evidence gates.
- **Distribution:** OpenAI package, hosted Claude plugin, endpoint-specific
  Claude package generator, credential scan, and package contract gates.
- **GitHub:** optional server-side bridge for allowlisted repositories, pull requests,
  Actions runs/jobs/redacted logs, branch creation, and pull-request creation without
  exposing the GitHub credential to AI clients or device agents. The hosted gateway
  supports both a protected credential broker for private/write access and an explicit
  credential-free read-only mode for allowlisted public repositories. Hosted smoke
  verifies that the configured GitHub path can actually reach an allowed repository.

## Still requiring production evidence or external approval

- Fresh-device one-command enrollment must be re-run against the live Main Platform
  service after the current agent/runtime update is deployed.
- A real stable/beta release manifest, detached signature, trusted public key,
  immutable archive and release sequence must be published and exercised on a
  live enrolled device, including observed failed-health rollback evidence.
- The VPS provider/hypervisor has produced abrupt external power events; guest logs did
  not show a normal Linux shutdown. Provider-side stability remains an infrastructure
  dependency rather than a CodeBridge software gate.
- Public Anthropic/OpenAI directory review is an external approval step. Repository
  packaging does not imply directory approval.
- Paid checkout, cancellation/refund, entitlement renewal/revocation, and real-customer
  lifecycle evidence must be verified before generally available paid-service claims.
- macOS/native Rust expansion, stronger untrusted-code isolation, shared durable gateway
  routing for multi-replica scale, formal penetration testing, and enterprise features
  remain later roadmap work.

## Release discipline

A change is considered merged only after its exact head passes the required CI gates.
A client, deployment, billing flow, or external approval is considered complete only
after a real end-to-end observation; source code or mocks alone are not reported as
production proof.
