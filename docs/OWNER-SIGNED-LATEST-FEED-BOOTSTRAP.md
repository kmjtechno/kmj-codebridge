# KMJ TECHNO — Signed Stable Latest Feed (Seq27 Bootstrap)

This is a **source-only owner-root** initial feed publisher. It is deliberately
not a signer, not an auto-approval system, not a timer installer and not a
generic "deploy anything from GitHub" task.

## Operator intent

The signed stable agent timer on KMJ-elite is present but **disabled**. Its
existing immutable Seq27 URLs do not point to a movable latest release. The
one-click controller from PR #948 expects two public **already signed** files:

- https://kmjtechno.com/codebridge/releases/stable/latest/release-manifest.json
- https://kmjtechno.com/codebridge/releases/stable/latest/release-manifest.sig

This operator tool copies the exact **existing immutable Seq27** signed files
under the pinned static Nginx origin root
\`/var/lib/kmj-codebridge-releases/stable\` into \`latest\`, using one atomic
\`renameat2(RENAME_NOREPLACE)\` directory publication. It never creates a
signature, makes up a version, trusts unsigned \`latest.json\`, downloads
code, rewrites any existing latest files or replaces a healthy release.

Before publication, it checks root-only source parents, both signed manifest
and signature, root-owned protected trust configuration, independent owner
SPKI Ed25519 pin, exact 512-byte manifest SHA256 and stable metadata, exact
archive SHA256/bytes and byte equality between the local manifest and
public HTTPS immutable Seq27 manifest. The initial feed either is created
once, is already byte-identical and externally verified, or fails closed.

### Source review and owner installation

The script is at
\`scripts/production/owner_publish_seq27_signed_latest_feed_20261115.py\`.
Run source-only CI including \`tests/owner-signed-latest-feed.test.js\` and
\`tests/test_owner_publish_seq27_signed_latest_feed.py\` first. Owner should
pin its exact reviewed SHA256 and execute via a protected root-installed
copy, not an arbitrary chat-supplied script or a GitHub URL piped to bash.

Readonly preflight (after owner-controlled pinned installation):

\`\`\`text
sudo /usr/bin/python3 -I -B /usr/local/libexec/kmj-codebridge/owner_publish_seq27_signed_latest_feed_20261115.py --inspect
\`\`\`

One-time publication (only after preflight PASS, explicit owner approval):

\`\`\`text
sudo /usr/bin/python3 -I -B /usr/local/libexec/kmj-codebridge/owner_publish_seq27_signed_latest_feed_20261115.py --apply --confirm-owner-publish-signed27-feed
\`\`\`

Expected receipt \`SIGNED_LATEST_FEED=CREATED_AND_PUBLIC_VERIFIED\` or
\`ALREADY_PUBLISHED_VERIFIED\`. A blocked attempt is **not** proof of
publication. A failed publication may leave a private staging folder under
the fixed static root; no automatic deletion or overwrite occurs. Do not
perform broad cleanup. Real HTTP can be blocked by WAF, so verify using
trusted owner-origin network context.

### Strong production boundary

This initial one-time feed contains **Seq27 only**. It **does not** magically
auto-publish Seq28 or any future feature. Future versions require an
owner-signed, independently admitted newer release, immutable archive,
monotonic sequence, atomically changed signed-feed directory pointer, public
byte verification and actual rollback/canary receipts. The current
create-only publisher will intentionally refuse a preexisting different
latest directory.

Only **after** the external feed has been verified and PR #948's
owner-approved installer/approval has been safely installed should the
existing \`kmj-codebridge-stable-update.timer\` be enabled. The signed
timer's agent-only nature and prior release backup/rollback checks remain.
This does NOT enable gateway, privileged Supervisor, Windows P520, Main
Platform, CloudOS, V3 backups or local LLM coding worker.

Owner private signing key is neither read nor required. V2 offsite, nginx,
systemd, updater config, gateway.json and health checks lines 25/28 are
unmodified by this publisher.
