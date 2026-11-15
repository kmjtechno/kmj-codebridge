# KMJ TECHNO — Monotonic signed stable/latest rollover (source only)

## Intent

The existing signed stable agent updater checks a **signed manifest pair**
about every 5 minutes when its timer is enabled. It does not by itself
publish newer releases to \`stable/latest\`. PR #952 supplies a **one-time
create-only Seq27 bootstrap**; this separate PR implements the second
piece: publish a future already owner-signed immutable release as the new
\`latest\`, without accepting an arbitrary Git branch or unsigned catalog.

\`scripts/production/owner_roll_signed_latest_feed_20261115.py\` performs
only owner-root, fixed-path actions:
1. Read the root-owned, private, nofollow \`stable-update.json\` and use
   its \`kmj-release-2026\` Ed25519 public key, checked against the
   independently owner-attested SHA256 SPKI pin.
2. Read each full-SHA-named immutable directory under pinned
   \`/var/lib/kmj-codebridge-releases/stable\` (max 256 entries).
   Verify all signed manifest/signature bytes and immutable archive
   SHA256/length, strict public archive origin, version and Node24 identity.
   Duplicate sequences, partial release, symlink and archive mismatch
   **fail closed**. No private key, signing action or GitHub branch lookup.
3. Require an existing signed \`latest\` two-file directory. It must be
   cryptographically verified before any replacement, with no
   downgrade/equivocation of the signed sequence.
4. Verify the candidate manifest, detached signature and immutable
   archive are publicly readable over the exact HTTPS origin and byte-exact.
5. **Readonly \`--inspect\` (default)** describes the verified signed
   candidate without changing files. Explicit owner \`--apply
   --confirm-owner-signed-rolling-feed\` stages a complete two-file
   directory, atomically swaps it using Linux \`renameat2(RENAME_EXCHANGE)\`
   and validates public \`latest\` readback. Original signed \`latest\`
   remains in the previously staged directory. No cleanup/overwrite.
6. If public readback fails, restore the old signed feed with a second
   atomic exchange *only if both sides still match exact expected bytes*;
   otherwise block for owner review without deleting evidence.

No change to nginx, systemd, gateway, Supervisor, CodeBridge agent, Main
Platform, offsite V2/V3 backup, database, DNS or private signer. The
publisher updates **feed metadata only**, not running application code.

### Production acceptance and scheduling

Before scheduling, an owner must independently install a reviewed, hash-pinned
root-controlled copy of the source with a fixed \`--apply\` systemd profile,
preserving exact identity, unit privilege sandbox and a one-writer lock.
This PR does **not** install/start that service or timer. Avoid a generic
root shell, arbitrary paths/arguments, or a mutable remote install script.
An approved timer could then look for new owner-signed immutable releases;
the existing CodeBridge signed agent updater timer consumes the feed.

- Release creation still requires source review, CI, owner signing outside
  this host and immutable archive publication.
- A new GitHub merge, green CI or unsigned \`latest.json\` is **not**
  sufficient to trigger a rollout.
- The feed might swap to a signed new release while the agent runs; its
  existing signature, antirollback, health and rollback rules still decide
  activation. Gateway/root Supervisor/Windows agents need independent
  signed multi-component admission and rollback, not this tool.
- Any failed publication, partial publish, rejected candidate or saved
  previous pair must be reconciled by an owner-controlled recovery process
  before automated retries are permitted. Never delete unknown vault entries.
- Root review must verify the actual Nginx static origin mapping and
  Cloudflare WAF/cache behavior. No public feed or service activation has
  been performed from this source PR.

### Test-only evidence

\`tests/test_owner_roll_signed_latest_feed.py\` uses synthetic disposable
manifests and a private temporary directory, simulating signature parser
failure, wrong archive origin, duplicate sequence, empty catalog, no
initial signed bootstrap, unexpected CLI parameters, real Linux atomic
exchange, failure rollback and preservation of the retired pair. This is
**not** a live signed release health or restore attestation.

The real owner public key and ten signed manifest fixtures remain verified
through the separately merged PR #951.
