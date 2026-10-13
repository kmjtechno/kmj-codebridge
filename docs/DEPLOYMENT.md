# Deployment and operations

## Local development

Follow README. Gateway defaults to loopback port 8787. Agent connections use outbound
HTTP only on loopback, otherwise HTTPS. Agent performs a long poll up to 10 seconds
and backs off on errors. It never follows gateway redirects with credentials.

Generate configuration outside the repository/project. The development initializer
is deliberately non-overwriting and read-only by default. The production-oriented
Linux installer can create/update the agent systemd service after explicit device
enrollment; it does not provision paid cloud resources. Stop development processes
with SIGINT/SIGTERM for a clean shutdown.

## Gateway container (operator-managed staging)

A Dockerfile is supplied but a container build has not been implied by source tests.
Mount a private gateway.json at /run/codebridge/gateway.json, readable by the container
node user. For container networking set host to 0.0.0.0 and explicitly set allowedHosts
to the exact public hostname. Terminate TLS at a trusted reverse proxy, preserve the
Host header, restrict inbound access and cap request size to 2 MiB. Configure approved
Origin values only if needed; do not use wildcard Origin allowances.

Do not publish a bare unauthenticated endpoint. Production user sign-in and token
validation must be connected to an approved OAuth issuer before public distribution.
Main Platform remains the billing/licensing authority.
Health endpoint returns only generic liveness; it is not a proof devices are reachable.

## Multiple devices and users

The administrator assigns a unique agent ID, tenant and independent random token hash
per device. A user record maps each device ID to its authorized project IDs and action
permissions. The agent independently maps project IDs to absolute canonical roots.
Device IDs never imply authorization. Keep credentials out of URLs, code and chat.

The repository implements the CodeBridge client side of verifier-bound, short-lived
device pairing. Main Platform source implements browser approval, atomic one-time
redemption, user/device introspection, and the related persistence model. Credential
rotation/global revocation and a fresh production pairing remain release evidence
gates. See [secure device enrollment](ENROLLMENT.md). Static provisioned accounts remain useful
for deterministic development tests but are not the final customer onboarding flow.

## Linux install, update and rollback

Target customer flow:

```sh
cd /absolute/project
curl -fsSL https://kmjtechno.com/install | sudo bash
```

The official-domain bootstrap should pin an immutable CodeBridge commit/release before
executing the full installer. Re-running the command is the supported repair/update
entry point; the installer preserves a valid device configuration and rolls back a
replacement runtime if startup/connectivity verification fails.

### Deployed-commit marker

Render injects `RENDER_GIT_COMMIT`. Any other gateway deployment, including the VPS
gateway that serves the customer-domain `/mcp`, should set
`CODEBRIDGE_SOURCE_COMMIT` to the exact deployed source SHA (lowercase hex, 7–40
characters). The validated value is returned by `/healthz` and as
`serverInfo.commit` in the public MCP `initialize` response; malformed values are
never echoed. `scripts/verify-public-mcp-catalog.mjs` reports each origin's commit
as `current`, `stale` or `unknown` against the commit under test, because an
identical tool catalog does not prove an identical gateway (for example, a
per-tool timeout fix changes behavior without changing tool names).

### Guarded gateway cutover checklist (operator-run)

Use this for any change to the production gateway that serves the customer-domain
`/mcp` and `/agent/` (the same listener serves both, so never move only one):

1. **Pin** the exact source SHA to deploy. It must already be on `main` with green
   CI at that exact commit. Never deploy a branch tip or a floating ref.
2. **Back up** the running release and its configuration (without printing secrets),
   and record the old commit so the rollback target is known.
3. **Stage and test** the candidate beside the running one (`npm ci`, `npm run check`,
   `npm test`, `npm run scan:secrets`) before touching the live listener.
4. **Cut over** with `CODEBRIDGE_SOURCE_COMMIT` set to the pinned SHA, preserving the
   listener port, OAuth configuration and device enrollments. Do not change DNS,
   OAuth issuers or agent credentials.
5. **Assert the result.** From any machine with outbound HTTPS:

   ```sh
   EXPECT_DEPLOYED_COMMIT=<40-hex-sha> node scripts/verify-public-mcp-catalog.mjs
   ```

   It exits non-zero unless the Render and customer-domain gateways both serve a
   complete tool catalog and report exactly that commit in `serverInfo.commit`
   (`MCP_DEPLOYED_COMMIT_ASSERT=PASS`). An origin that reports no commit counts as
   a failure, because it proves nothing.

6. **Roll back** to the recorded old release if the assertion or any health check
   fails, then re-run the assertion against the old SHA.

The installer does not accept or require a permanent token in the URL or command.
On first install it requests a short-lived S256 verifier-bound enrollment, displays
the approval URL/code and waits for the Main Platform response. On success it writes
the independent device credential into mode-0600 configuration and starts a hardened
systemd service.

On rerun, an existing valid configuration is preserved and the runtime is staged as
an update. The previous runtime/configuration remain available until service startup
and gateway metadata connectivity both pass. A failed replacement triggers rollback.
Invalid existing configuration is not silently overwritten.

Project selection defaults to the current directory only when it contains a recognized
project marker (.git, package.json, composer.json, pyproject.toml, Cargo.toml or
go.mod); otherwise --project is required. No inbound agent port or GitHub Actions
runner is installed.

Main Platform source now contains the API described in
[ENROLLMENT.md](ENROLLMENT.md). General production readiness still requires a recorded
fresh first-install pairing against the deployed service.

## Recovery

- Restart gateway: in-memory pending requests are lost; do not blindly replay writes.
- Lost tool response: reread file state; quality-gate retries must use the same requestKey.
- Agent restart: old running journal entries become interrupted; never assume old
  subprocesses are gone after a hard crash. The agent automatically replaces its own
  state lock only when staleness is provable (different Linux boot ID or dead PID); a
  live or malformed lock still fails closed.
- Graceful cancellation: process groups are terminated on Linux; taskkill tree termination
  is used on Windows. Validate Windows behavior in CI before claiming support.
- Journal full: new jobs stop. Export/archive under a documented idempotency retention
  policy before clearing old records; automatic pruning is not implemented.
- Entitlement outage: already installed, valid signed leases remain verifiable. Optional
  signed renewal is available; live contract mapping and signed revocation remain unverified.

## Public plugin

Package only after establishing a real stable HTTPS /mcp endpoint and supported user
authentication. Validate with MCP Inspector and then an actual ChatGPT session. OpenAI
review and publication are separate from GitHub upload. Do not publish a skills-only
shell as if it already connects customer machines.

## Managed hosting entry point

`npm start` runs the OAuth-required gateway on `0.0.0.0:$PORT` (default 10000).
Set `CODEBRIDGE_GATEWAY_CONFIG` through the hosting provider's private configuration
interface to the complete gateway JSON described in [OAuth configuration](OAUTH.md).
There is no insecure default account, fake issuer or generated public credential.
The public resource hostname must be explicitly listed in `allowedHosts`. Invalid
configuration fails startup without printing its contents. SIGTERM closes the gateway.

For a native Node service, select Node 24, build with `npm ci --ignore-scripts`, start
with `npm start`, and use `/healthz` for health checks. Verify the platform's health
check Host header matches an explicitly allowed hostname. Do not add wildcard hosts.
Use one instance initially: pending request routing is in memory, so multiple gateway
replicas require a shared routing layer that this preview does not implement.

Hosted OAuth infrastructure is now used by the public
`https://kmjtechno.com/mcp` client path. Each deployment must still verify the exact
issuer/resource/JWKS configuration, allowed host, account mapping, and agent
introspection settings before rollout. Production signing keys are never needed by the
gateway.

The hosted entry point remains tested behind a TLS-termination boundary, while real
Claude OAuth sessions have additionally exercised the public MCP resource. Provider
availability, proxy/WAF behavior, and capacity must still be monitored before making
an uptime or scale claim.

## Hosted acceptance during a production VPS outage

The scheduled **Hosted Deployment Smoke** workflow has two independent,
mandatory jobs. `gateway` validates the deployed Render CodeBridge release
version and hosted GitHub capability; `public_oauth` validates the separate
`kmjtechno.com` production OAuth discovery and anonymous read/write challenge
contract. Neither job depends on the other or uses `continue-on-error`.

When the production VPS or its network is unreachable, `public_oauth` **must
fail** even if `gateway` is green. This is expected incident evidence, not
permission to waive production acceptance. A green gateway job proves only
its stated scope; it never proves customer login, entitlement renewal, paid
checkout, or an authenticated CodeBridge device round trip. Keep any live
rollout blocked until both jobs pass and the actual client/device verification
is repeated. Production recovery must retain the current database, OAuth
signing authority, DNS and existing agents. Do not use a secondary/testing VM
as production merely because its remote agent is online.

## Verified runtime downloads

Every successful CI matrix job now builds a source-runtime `.tar.gz`, `manifest.json`
and `SHA256SUMS`, uploaded as a workflow artifact for 14 days. The manifest pins the
full source commit. Download from that run's Artifacts section, verify the archive
checksum, extract, then run `npm ci --ignore-scripts` with Node.js 24 before startup.
This source bundle still needs npm registry access and private configuration. It is
not a self-contained native executable, signed installer or connected ChatGPT plugin.

`npm run package:runtime` builds from a clean committed tree and refuses to overwrite
an existing output directory. Untracked files are excluded; known credential filenames
cause packaging to fail if tracked. This filename check is defense in depth, not a
full secret scanner. SHA256 detects corruption when compared against a trusted manifest;
it does not establish publisher identity without a separately trusted signature.
