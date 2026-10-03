# Signed CodeBridge Updates

KMJ CodeBridge release updates use a separate Ed25519 trust boundary from OAuth and from repository access. Runtime devices never need a GitHub token and never receive a release signing private key.

## Signed update manifest

The release pipeline first creates the existing source-runtime archive and SHA-256 metadata. A separate signing step then creates:

- `update-manifest.json`
- `update-manifest.sig.json`

The manifest is bounded and contains only:

- format/version identifiers
- stable or beta channel
- strictly increasing release sequence
- semantic product version
- exact Git revision
- Node.js major requirement
- public HTTPS archive URL
- expected archive byte length
- SHA-256 archive digest

The signature envelope contains only `v`, `alg=EdDSA`, `kid` and a base64url Ed25519 signature over the **exact manifest bytes**.

Unknown manifest fields are rejected. Literal localhost/private-network archive hosts, credential-bearing URLs and non-HTTPS archive URLs are rejected before download.

## Anti-rollback

Every installed release records the highest accepted sequence. A normal update is accepted only when:

`manifest.sequence > installedHighestSequence`

This blocks replay and downgrade through the update channel even when an older release was once validly signed.

Explicit rollback is a different Supervisor operation: it may activate only the locally recorded previous-known-good release. It must not fetch or accept an arbitrary older signed release.

## Release signing

The private release key must live outside the repository and outside customer runtime installations.

Example build-host invocation:

```sh
CODEBRIDGE_RELEASE_KEY_FILE=/secure/kmj-codebridge-release-ed25519.pem \
CODEBRIDGE_RELEASE_KID=release-2026 \
npm run sign:runtime -- \
  dist/runtime/manifest.json \
  https://releases.kmjtechno.com/codebridge/<archive>.tar.gz \
  42
```

The signer refuses a private key path inside the checked-out repository. The private key bytes are never written into release output.

## Verification order

A future Supervisor update operation must use this order:

1. fetch bounded manifest and signature;
2. verify Ed25519 signature and trusted key id;
3. enforce monotonically increasing sequence;
4. download the archive with bounded size;
5. verify exact byte length and SHA-256;
6. unpack into a new immutable release directory;
7. run preflight;
8. atomically switch `current`;
9. restart and health-check;
10. keep the old release as `previous-known-good`;
11. automatically restore it if health validation fails.

This document does not claim steps 6–11 are implemented yet. The current slice implements and tests the signed-manifest, anti-rollback and archive-integrity trust boundary only.
