# Offline cryptographic release-bundle verifier

The source-runtime CI artifact is **unsigned** until the KMJ owner signs it
with the existing offline Ed25519 release key. The generic
`release-acceptance-gate.mjs` checks operator-declared evidence only;
this verifier **checks the actual owner signature and archive bytes**.

The zero-cost, offline, read-only verifier requires five **existing regular
files** plus the last accepted release sequence:

```bash
node scripts/verify-signed-bundle.mjs \
  /private/release-manifest.json \
  /private/release-manifest.sig \
  /private/trusted-public-keys.json \
  /private/runtime/manifest.json \
  /private/runtime/kmj-codebridge-0.3.2-<sha12>.tar.gz \
  11
```

Here `11` means the device already accepted sequence 11; a candidate at
sequence 11 or earlier is rejected. Never guess or silently reduce the
device's actual accepted sequence.

## Verification performed

- Parse and verify the exact raw signed-manifest bytes with an Ed25519
  signature using a **trusted public** SPKI key ID, not the private signing
  key; enforce the monotonic sequence.
- Match signed revision, version, archive URL filename, byte count and digest
  to the corresponding unsigned CI runtime manifest and archive filename.
- Stream SHA-256 over the local archive (up to 512 MiB); check declared size
  before and after. Do not unpack or execute it.
- Reject symlinks, multi-linked files, unreadable/oversized metadata files,
  incorrect signatures, archive tampering, unknown signing keys, and old
  sequences.
- Emit fixed read-only `CRYPTOGRAPHICALLY_VERIFIED` metadata on success,
  without exposing key material or absolute filesystem paths. Report only
  `SIGNED_BUNDLE_VERIFICATION_FAILED` from the CLI if verification fails.

This verifier does **not** establish live Render or VPS connectivity, exact
GitHub CI head, executable runtime security, authenticated MCP access,
archive extraction layout, safe rollback, public registry publication, or
owner activation approval. An operator must separately verify those
conditions. Do not treat cryptographically verified local archive bytes as
a published GitHub Release or production-ready build.

The verifier never signs, downloads, deploys, changes the updater, changes
systemd units, reads private keys or calls a paid API. In particular, never
paste private signing keys or renewal tokens in a chat or a GitHub issue.
