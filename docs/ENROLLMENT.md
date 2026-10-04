# Secure device enrollment contract

KMJ CodeBridge supports a zero-manual-token installer flow. KMJ Main Platform remains
the account/licensing authority and its current source implements the create, browser
approval, redemption, device-introspection, and user-introspection sides of this
contract. A production install is complete only after those routes are enabled and a
fresh device has successfully paired against the live service.

The installer never places a bearer token, API key or permanent credential in the
installation URL or command. It creates a local verifier, sends only its S256
challenge during enrollment creation, displays only the approval URL and human code,
and redeems the approved enrollment with the original verifier.

## Customer flow

From an authorized project directory:

```sh
curl -fsSL https://kmjtechno.com/install | sudo bash
```

The installer:

1. Detects Linux architecture and verifies/install dependencies.
2. Downloads CodeBridge and verifies Node.js using the official Node checksum list.
3. Creates a verifier-bound, short-lived enrollment request.
4. Prints an HTTPS approval URL and short human code only.
5. Waits for explicit approval in KMJ Main Platform / CodeBridge.
6. Exchanges the approved one-time enrollment for an independent device credential and the authoritative agent gateway origin.
7. Writes the device credential and agent gateway only into mode-0600 agent configuration.
8. Installs a hardened systemd service, enables boot start and starts the agent.
9. Verifies local service state and HTTPS gateway metadata connectivity.
10. On update failure, restores the previous runtime/configuration.

No inbound VPS port and no GitHub Actions self-hosted runner are required.

## API version

Base examples below use the Main Platform origin. Exact production routing may place
the same paths behind a dedicated CodeBridge hostname, but the API semantics are
versioned and must remain compatible.

### Create enrollment

`POST /api/codebridge/v1/device-enrollments`

Request:

```json
{
  "product": "KMJ_CODEBRIDGE",
  "device": {
    "id": "customer-vps-01",
    "name": "customer-vps-01",
    "platform": "linux",
    "arch": "x64"
  },
  "project": {
    "id": "project1",
    "name": "customer-app"
  },
  "requested_permissions": ["read", "write", "execute"],
  "code_challenge": "<base64url-sha256>",
  "code_challenge_method": "S256"
}
```

Success: HTTP 201.

```json
{
  "device_code": "<high-entropy single-use opaque secret>",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://kmjtechno.com/codebridge/pair",
  "verification_uri_complete": "https://kmjtechno.com/codebridge/pair?code=ABCD-EFGH",
  "expires_in": 300,
  "interval": 5
}
```

Rules:

- `device_code` MUST contain at least 256 bits of cryptographic entropy.
- `user_code` is for human verification and MUST NOT be sufficient to redeem a device.
- Enrollment lifetime SHOULD be 5 minutes and MUST be no more than 30 minutes.
- Store only a one-way digest of `device_code` where practical.
- Store the S256 challenge and bind it to product/device/requested project/scopes.
- Rate-limit enrollment creation by IP/account/device characteristics.

### Browser approval

`GET/POST /codebridge/pair` is authenticated by the existing KMJ account session.

Before approval the page MUST show:

- device name/id,
- requested project,
- requested read/write/execute permissions,
- expiration,
- tenant/account receiving the device.

Approval MUST bind the enrollment to the authenticated tenant and final approved
project/permissions. A denial is terminal. Approval does not expose the device
credential to the browser.

### Poll/redeem enrollment

`POST /api/codebridge/v1/device-enrollments/token`

Request:

```json
{
  "product": "KMJ_CODEBRIDGE",
  "device_code": "<opaque secret from create response>",
  "code_verifier": "<original local verifier>",
  "device_id": "customer-vps-01"
}
```

Responses:

- HTTP 428: approval pending.
- HTTP 429: slow down; client increases poll interval.
- HTTP 403: denied.
- HTTP 410: expired or already consumed.
- HTTP 400: invalid request/verifier/device binding.
- HTTP 200: approved and consumed.

Success body:

```json
{
  "gateway": "https://kmj-codebridge-gateway.onrender.com",
  "agent": {
    "token": "<independent random device bearer credential>",
    "id": "customer-vps-01",
    "tenant": "tenant-id"
  },
  "projects": [{ "id": "project1" }],
  "permissions": ["read", "write", "execute"],
  "credential_expires_at": "2026-11-01T00:00:00Z"
}
```

On the first successful HTTP 200 redemption the enrollment record MUST be atomically
marked consumed. Any later redemption MUST fail. The server MUST validate the
S256 verifier, approved tenant, device id, approved project and approved permissions.

The returned agent token MUST be independently generated; it MUST NOT be derived from
the human code or device code. The optional `gateway` field is the canonical HTTPS
origin used by outbound agent traffic (`/agent/health`, `/agent/poll`,
`/agent/result`). It is distinct from the Main Platform enrollment/account origin and
must not point at the public `/mcp` proxy unless that origin actually serves the agent
routes. Older servers that omit `gateway` remain compatible with the installer's
configured production fallback.

## Rotation and revocation contract

The final Main Platform integration should expose authenticated account/admin
operations equivalent to:

- `POST /api/codebridge/v1/devices/{device}/rotate-credential`
- `POST /api/codebridge/v1/devices/{device}/revoke`

Rotation returns a new independent device credential and invalidates the previous
credential after a bounded overlap window. Revocation stops future gateway agent
authentication. These lifecycle operations remain release gates unless the deployed
Main Platform version exposes and verifies them end-to-end.

## Installer persistence and update policy

- Fresh configuration is created mode 0600.
- Existing valid credentials and project bindings are preserved on rerun; the configured agent gateway may be repaired to the requested production gateway without re-pairing.
- Invalid existing configuration is never silently overwritten.
- Runtime updates are staged in a new directory.
- The previous runtime and config are retained until the new service and gateway
  connectivity checks pass.
- Failure triggers rollback to the previous runtime/config.
- No credential is printed to stdout/stderr.
- No GitHub credential or self-hosted runner is required.

## Current production gate

The CodeBridge repository implements the enrollment client and hardened installer.
KMJ Main Platform source implements the matching create, approval, redemption, user
introspection, and device-credential introspection routes. The remaining release proof
is operational: the public installer bootstrap, production feature flags, Main Platform
deployment, gateway configuration, and one fresh-device pairing must all be observed
together.

The installer fails clearly rather than manufacturing a fake local enrollment when a
required server route, approval, or credential exchange is unavailable.
