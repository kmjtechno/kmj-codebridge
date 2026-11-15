# Cryptographic latest Stable release verification (issue #917)

This is a SOURCE-ONLY security correction, not production deployment approval.
Never label a JSON sequence, filename or a GitHub archive as owner-signed
unless the exact manifest bytes are verified with a separately trusted key.

## Required owner-managed public trust

GitHub hosted smoke reads the repository/environment variable
KMJ_CODEBRIDGE_RELEASE_TRUSTED_KEYS_JSON into the process environment
CODEBRIDGE_RELEASE_TRUSTED_KEYS_JSON. The value is a JSON object mapping
trusted key IDs (such as kmj-release-2026) to verified Ed25519 PUBLIC SPKI
PEM strings. This repo does NOT contain the owner signing private key.
Never take a PEM out of an untrusted catalog and treat it as owner-trusted.

If the variable is missing, invalid or untrusted, the smoke step fails
closed. It must not be bypassed or silently default to sequence sorting.
The source PR cannot attest that the owner managed setting already exists;
the repository owner must independently compare the public key to the
existing signed-updater trust pin and set it through authorized settings.
No production config, service or timer is changed here.

Optional CODEBRIDGE_RELEASE_MIN_SEQUENCE sets a strictly lower bound for
newest accepted sequence. Never guess or reduce the device's accepted floor.

## Security checks

- Reuse production verifyReleaseManifest Ed25519 raw-byte verifier.
- Validate trusted key ID, stable channel, revision, archive HTTPS path,
  SHA-40 revision directory, positive integer sequence and exact filename.
- Verify EVERY eligible candidate; never skip an unsigned higher sequence.
- Refuse missing signature, tampered signature/manifest, unknown/wrong key,
  symlinked path, multi-link file, duplicate sequence and stale rollback.
- Bounded/no-follow inode-stable file reads; sanitize CLI errors.
- Offline negative fixture suite uses ephemeral generated Ed25519 keys.

## Release and safety gates

Green CI only proves source code tests, not a signed KMJ-elite runtime.
Keep gateway.json at kmjcode:kmjcode mode 0600 until an exact signed
release containing PR #929 is confirmed live and startup-preflight PASS.
Do not edit health-check lines 25/28, change mtimes, or alter offsite V2.
Rootless Seq26 tools from PR #932/#935 are source merged but NOT included
in the older signed Seq26 #934 archive. A fresh owner-signed successor is
required, followed by startup, OAuth/MCP, agent and rollback validation.
No owner signing action, paid service or deployment occurs in this PR.
