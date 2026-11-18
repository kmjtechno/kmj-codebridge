# KMJ TECHNO — owner release public-key evidence

## Why this gate exists

Scripts that merely contain the value
\`2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8\`
are **not an independent origin proof** for the release Ed25519 public key.
The owner-protected stable updater configuration is the intended source.
A signed release manifest is not a source for its own public key.

Use \`scripts/verify-owner-release-public-key.mjs\` only after a public PEM
was exported from \`/etc/kmj-codebridge-update/stable-update.json\` by an
approved owner-side procedure. **Never export a private key or updater
configuration, or commit the private key or configuration.** The exported
PEM must have only the literal "BEGIN PUBLIC KEY" and "END PUBLIC KEY"
wrapper; no private material. The public key can be read by a non-root
offline verifier. The verifier never writes a file or sends data off-host.

Example invocation in a trusted clone that contains signed release files:

\`\`\`bash
node scripts/verify-owner-release-public-key.mjs --public-key-file /absolute/path/to/KMJ_RELEASE_PUBKEY_20261115.pem
\`\`\`

It checks the actual supplied public key's SPKI SHA256 fingerprint against
the expected owner pin, then cryptographically verifies the **raw bytes**
of the ten committed manifest/signature pairs: sequences 15, 19, 20, 21,
22, 23, 24, 25, 26 and 27. A bad signature, unrelated key, mismatched
sequence/revision, changed manifest, wrong channel, malformed base64url,
missing file or symlink fails closed. No GitHub network request, sudo,
untrusted manifest URL or mutable "latest" alias is involved.

Expected successful receipt:

\`\`\`text
OWNER_PUBLIC_SPKI_SHA256=2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8
RELEASE_SIGNATURES_VERIFIED=10/10
OWNER_RELEASE_KEY_CUSTODY=REQUIRES_ROOT_CONFIG_SOURCE_PROOF
RELEASE_SOURCE_MUTATIONS=NONE
\`\`\`

The last line is critical: signature success and fingerprint consistency do
not prove who exported the key, whether the owner controls the signing
private key or whether the root protected source was correctly read. For a
production trust promotion, a separately approved root-side provenance
receipt (owner, file mode, key id and fingerprint, without leaking unrelated
configuration fields) must be reviewed. If CodeBridge returns PATH_DENIED
when reading the export under work/qa, **do not bypass its project
allowlist**; use an existing authorized owner evidence channel instead.
No generic root-shell capability is granted by these scripts.

### Automated GitHub Release signature admission

Before the immutable GitHub Release publish action, the fixed
publish-signed-stable workflow must run
scripts/verify-signed-owner-release.mjs against the exact release SHA.
The verifier reads the existing owner-supplied PUBLIC PEM fixture, pins the
actual Ed25519 SPKI SHA-256, verifies detached signature against the exact
manifest file bytes and checks identity, archive URL, version, sequence and
key ID. It does not fetch a key or permit the newly proposed manifest to
self-select its trust. Missing/tampered/invalid owner signatures now block
the GitHub Release creation step, even if the archive rebuilt correctly.

In addition, each release must name a source Git SHA that is an
actual ancestor of the **protected main** base commit (on pull-request
verification) or the exact push/dispatch SHA (when publishing). A separately
signed but unmerged/off-branch source commit is not eligible for automatic
stable publication. The workflow fails closed with
`SIGNED_SOURCE_NOT_ON_PROTECTED_MAIN`, never using the untrusted PR head
as its source ancestry authority.

This is an **authenticity gate**, not a claim that an owner private key is
available to GitHub, that the release passed live VPS signing-key custody
review, or that agents safely installed it. Those production gates remain
independent. The public key fixture is not secret, but its SHA-256 pin
must never be changed merely to make a release PR green.

### Merge / deployment rules

- PR #944 is about requiring a real signed latest release catalog, not
  merely checking an existing fingerprint literal.
- PR #948 is an opt-in signed updater; its authorizing trust key must be
  proven independently before enabling live automatic deployment.
- Publish a stable/latest feed only **after** verifying owner custody,
  source CI, release signatures, exact archive hashes and the signed
  monotonic sequence. A GitHub merge is not production signing.
- A newer release needs a release-level signature and health/rollback
  gates; automatically accepting an untrusted GitHub branch is forbidden.
- Never touch Seq26 legacy scripts, gateway.json ownership, V2 backups,
  Main Platform health lines 25/28 or the owner private signing key.

## Actual owner PEM cross-verification — 2026-11-15

The owner supplied the public PEM printed by a read-only root command that
opened /etc/kmj-codebridge-update/stable-update.json using O_NOFOLLOW,
required UID 0, regular single-linked file, mode 0600 and read the
trustedKeys.kmj-release-2026 field. The key is **public-only**.

- PEM SHA-256 (exact owner-supplied bytes):
  `e2cc3af00ed64206f1e86c7f26a15805491b3fd2ec5948b4897e883719be8c0c`
- Public key type: Ed25519
- DER/SPKI SHA-256:
  `2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8`
- Ten release manifest bytes were reconstructed byte-for-byte from retrieved
  GitHub content and checked against each Git blob SHA-1, **10/10 MATCH**;
  signatures verified on those exact bytes with this owner-supplied public
  key: **Seq15 and Seq19–27, 10/10 PASS**.
- Repository CI now runs the same **real ten-signature verification** using
  `tests/fixtures/KMJ_RELEASE_PUBLIC_KEY_EVIDENCE_20261115.txt`. This is
  a public-only fixture, not a credential or a new signing authority.
  It must not be used to authorize an unreviewed future release without
  exact sequence, signed manifest, archive hash and owner rollout policy.

These observations establish consistent owner-supplied public-key provenance
and authentic detached signatures of the ten committed releases. They do
**not** prove private-key custody, live origin feed publication, health check,
rollback readiness or production auto-updater enablement.
