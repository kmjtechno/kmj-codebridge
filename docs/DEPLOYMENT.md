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
validation must be connected to Main Platform OAuth before public distribution.
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
- Entitlement outage: already installed, valid signed leases remain verifiable. Actual
  renewal/revocation fetching is not implemented in this preview.

## Public plugin

Package only after establishing a real stable HTTPS /mcp endpoint and supported user
authentication. Validate with MCP Inspector and then an actual ChatGPT session. OpenAI
review and publication are separate from GitHub upload. Do not publish a skills-only
shell as if it already connects customer machines.
