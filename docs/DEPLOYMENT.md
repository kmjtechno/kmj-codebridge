# Deployment and operations

## Local development

Follow README. Gateway defaults to loopback port 8787. Agent connections use outbound
HTTP only on loopback, otherwise HTTPS. Agent performs a long poll up to 10 seconds
and backs off on errors. It never follows gateway redirects with credentials.

Generate configuration outside the repository/project. The initializer is deliberately
non-overwriting and read-only by default. There is no auto-installed service or paid
cloud resource. Stop processes with SIGINT/SIGTERM for a clean shutdown.

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

The preview accepts static provisioned accounts. Account linking, pairing UI, global
revocation and live commercial provisioning are future release gates.

## Recovery

- Restart gateway: in-memory pending requests are lost; do not blindly replay writes.
- Lost tool response: reread file state; quality-gate retries must use the same requestKey.
- Agent restart: old running journal entries become interrupted; never assume old
  subprocesses are gone after a hard crash. Operator checks precede removing a stale lock.
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

Required before deployment: confirmed hosting workspace, approved public resource URL,
real OAuth issuer/public keys, administrator-mapped subjects and separately provisioned
agent credentials. Production signing keys are never needed by this gateway.

This entry point is tested over HTTP behind the expected TLS termination boundary.
A hosting deployment, TLS endpoint or successful live account link is not implied by
passing source tests. Provider-specific cold starts, quotas and availability must be
validated for the selected plan before promising always-on connectivity.
