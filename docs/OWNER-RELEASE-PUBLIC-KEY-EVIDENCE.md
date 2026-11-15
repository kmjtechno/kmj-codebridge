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
