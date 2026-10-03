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
