# KMJ Main Platform integration boundary

Main Platform is the sole commercial authority. This preview implements verification,
not a second billing system. No server signing private key belongs on an agent.

## Proposed signed envelope

Compact JWS: base64url(header).base64url(payload).base64url(Ed25519 signature).
Header: `{"alg":"EdDSA","kid":"<trusted-key-id>","typ":"JWT"}`.
Configure trusted SPKI PEM public keys in the private agent configuration. Unknown
keys and algorithms are rejected. Example claims are illustrative, not valid licenses:

```json
{
  "v": 1,
  "product": "KMJ_CODEBRIDGE",
  "tenant": "customer-id",
  "device": "registered-device-id",
  "license_id": "license-id",
  "activation_id": "activation-id",
  "jti": "unique-token-id",
  "sequence": 1,
  "iat": 1800000000,
  "nbf": 1800000000,
  "exp": 1800086400,
  "grace_until": 1800259200,
  "features": ["read", "write", "execute"],
  "limits": { "devices": 3, "concurrent_jobs": 2 }
}
```

Signed mode configuration:

```json
{
  "mode": "signed",
  "tokenFile": "/private/entitlement.jws",
  "keys": { "<kid>": "<SPKI PEM public key>" }
}
```

The token must be issued by an actual authorized Main Platform signer. This is a
**proposed CodeBridge adapter contract**, not proof of compatibility with deployed
KSLP-v1. Confirm field mapping and versioning against the live contract before shipping.

## Implemented

Signature, product/tenant/device binding, required identity fields, integer time
claims, expiry, signed grace up to 48 hours, feature allowlist and concurrency limit.
Persisted sequence and wall-clock high-water marks resist replay/clock rollback while
local state remains intact. Status and cancellation remain available after expiry.
No synchronous Main Platform call is made for each tool invocation.

## Production integration still required

- Enrollment binds device ID to a real keypair fingerprint, with Main Platform authorization.
- Activation, 14-day trial issuance and 24-hour renewable leases use the actual KSLP API.
- Enforce account-wide device and plan limits on Main Platform and gateway; the local
  verifier parses device limits but cannot count devices on other machines.
- Implement renewal, key discovery/rotation, revocation distribution and token replacement.
- Bind replay history to activation lifecycle and test renewal/recovery migrations.
- Add gateway-side commercial enforcement; a user who controls the agent binary can
  alter local checks. Local verification alone is not anti-cracking protection.
- Verify billing webhooks, payment/renewal/cancellation/refund reconciliation and trial abuse controls.
- Configure approved key storage, policy and operational audit retention.

Never treat Free mode as a locally issued commercial trial. No payments are taken by
this preview. Pricing and trial limits in the roadmap remain proposals.

## Optional renewal client (proposed contract)

Signed agent configuration now accepts `renewal` with `endpoint` (HTTPS URL without
credentials/query/fragment), `credential` (private service credential, at least 32
characters) and `intervalSeconds` (60–86400; default 3600). The agent attempts renewal
at startup and periodically, independently of tool invocation. A request is limited
to five seconds, redirects are refused and the response is limited to 32 KiB.

The POST body is `{product, tenant, device, sequence}`; the expected response is
`{token: "<signed compact JWS>"}`. Only an ACTIVE signature-verified token with a
strictly higher sequence is installed using a synced temporary file and atomic
replacement. Existing replay/time checks remain enforced. Transport errors, unsigned
errors and invalid responses preserve the existing cache; they never extend its
signed expiry/grace. HTTP 403 alone is not a signed revocation and does not erase
cached access. Immediate signed revocation distribution remains outstanding.

This transport contract has not been verified against the live Main Platform API.
Do not point it at the sandbox HMAC issuer. Initial activation must supply the token
file; this client does not issue trials, accept payments or enroll a device. Renewal
runs on the polling loop, so a renewal can delay the next poll by up to five seconds.
A failed renewal waits until the configured next interval. Choose the interval well
below the issuer's lease lifetime and rotate service credentials outside the model.

The entitlement path is canonicalized before checking project boundaries and before
replacement, including configured symlink aliases. Replay-state persistence is not a
power-loss-proof database: directory fsync and transactional state/token recovery
remain production durability work. Keep state outside project access and back it up
with controlled recovery procedures.
