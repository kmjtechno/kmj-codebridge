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
  Supervisor are implemented. Live account-wide discovery is verified: the
  authenticated account resolves both `device1/project1` and
  `main-platform-kmjtechnonetgmailcom/kmj-main-platform` online, and
  `connection_overview` reports both READY with zero attention items.
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
  UI, and regression tests. The one-command bootstrap pins the setup helper to
  an immutable 40-hex revision and verifies its exact SHA-256 before execution;
  tests require HTTPS/TLS, forbid curl-pipe-bash and manual agent-token
  injection, preserve existing enrollment, and limit repository authorization
  to a read-only deploy key. A fixed Supervisor refresh operation updates an
  already-enrolled Main Platform agent without accepting a repository, path,
  service name, command, credential, or new-enrollment input.
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
- **Developer workflow:** opt-in Node/Python/Cargo/Go structured command
  presets run through the existing bounded job runner without exposing a raw
  shell; deterministic security/debugging/TDD/release-readiness skill
  recommendations and bounded local repository intelligence are implemented.
  Repository intelligence is metadata-only, skips denied/vendor trees, caps
  files/results/bytes, and does not upload repository content to hosted AI.
- **Scale regression evidence:** the benchmark includes separately labelled
  deterministic 1/10/100/1000-agent in-process control-plane simulations with
  latency and metadata budgets. All four budgets passed on current main. This
  is regression evidence, not a claim of a real 1000-device network or
  multi-replica load test.
- **Distribution:** OpenAI package, hosted Claude plugin, endpoint-specific
  Claude package generator, credential scan, and package contract gates.
- **GitHub:** optional server-side bridge for allowlisted repositories, pull requests,
  Actions runs/jobs/redacted logs, branch creation, and pull-request creation without
  exposing the GitHub credential to AI clients or device agents. The hosted gateway
  supports both a protected credential broker for private/write access and an explicit
  credential-free read-only mode for allowlisted public repositories. Hosted smoke
  verifies that the configured GitHub path can actually reach an allowed repository.

## Still requiring production evidence or external approval

- Fresh-device one-command enrollment now has deterministic bootstrap/repair
  coverage, while the existing production enrollment is online and refreshable
  without re-pairing. A recorded end-to-end pairing on a disposable fresh
  device is still required before claiming fresh-device production proof.
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

## Current verification snapshot

On current main `c47912ad4c198e6b43cbca5f4487447005dd8147`, the full local gate set
passed: formatting/static checks; 398 tests with 396 pass, 0 fail and 2 skip;
credential scan across 196 tracked files; client tests with 12 pass, 0 fail and
1 skip; Claude marketplace canonical check; and the benchmark, including all
1/10/100/1000 simulated-scale budgets. The live account reported both
`device1/project1` and
`main-platform-kmjtechnonetgmailcom/kmj-main-platform` READY.

## Release discipline

A change is considered merged only after its exact head passes the required CI gates.
A client, deployment, billing flow, or external approval is considered complete only
after a real end-to-end observation; source code or mocks alone are not reported as
production proof.
