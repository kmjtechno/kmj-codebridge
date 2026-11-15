# KMJ TECHNO — One Owner Action: Signed Auto-Update Activation

This is an owner-reviewed **single invocation** coordinator for the existing
fixed root-installed publisher and signed-agent updater. It must not be
interpreted as an unsigned GitHub-merge deployer, a signer, a generic root
command tool, or live deployment proof. No private key is read or used.

## Already reviewed prerequisites

- Trust source: owner-verified public Ed25519 key from protected
  \`/etc/kmj-codebridge-update/stable-update.json\`, independently matching
  SHA256(SPKI DER) \`2c49c1ce...c51f8\`. Seq15 and Seq19–27 signatures
  confirmed 10/10; source in merged PR #951.
- Initial publisher source: merged PR #952,
  \`owner_publish_seq27_signed_latest_feed_20261115.py\`.
- Agent-only signed-update controller: merged PR #948,
  \`owner_oneclick_signed_autoupdate.py\`.
- The **owner** must independently review, hash-pin, install and protect all
  three exact source files at:
  \`/usr/local/libexec/kmj-codebridge/\`, owned by root with non-writable
  directory ancestry and regular, non-symlink helper files.
- Existing Seq27 archive, immutable manifest and signature must be valid in
  the pinned static Nginx root **and externally over HTTPS**.
- Existing \`kmj-codebridge-stable-update.timer\` and service must match
  the installed signed-agent contract; no development/unsigned timer conflict.

### One-time activation after those prerequisites

The one-pass helper has exactly one production apply action:

\`\`\`text
sudo /usr/bin/python3 -I -B /usr/local/libexec/kmj-codebridge/owner_onepass_signed_agent_autoupdate_20261115.py --apply --confirm-owner-production-auto-signed-agent
\`\`\`

This calls only the two already approved helpers, using fixed CLI flags
and no caller-supplied paths:

1. Signed Seq27 immutable release preflight, including owner public key,
   manifest signature, local+public archive hash and public origin.
2. Atomic no-overwrite publication of the initial signed \`stable/latest\`
   manifest/signature pair. Repeated invocation is idempotent if identical.
3. Create-only root-private \`0600\` policy with an exact signed stable
   agent-only scope; mismatched policy/permissions fail closed, never overwrite.
4. Verify the **signed** latest feed and enable the existing signed
   updater timer. On enable failure the merged #948 controller stops the
   newly started timer and restores its previous config, or blocks with an
   explicit recovery review state.

If step 4 fails after step 2, the valid signed feed remains; it is not
deleted. A success token requires the timer enable action to return; the
operator must still independently read back systemd + signed-agent state and
run authenticated health/rollback acceptance before declaring production
readiness.

Readonly status:

\`\`\`text
sudo /usr/bin/python3 -I -B /usr/local/libexec/kmj-codebridge/owner_onepass_signed_agent_autoupdate_20261115.py --status
\`\`\`

Owner-approved timer opt-out:

\`\`\`text
sudo /usr/bin/python3 -I -B /usr/local/libexec/kmj-codebridge/owner_onepass_signed_agent_autoupdate_20261115.py --disable --confirm-owner-production-auto-signed-agent
\`\`\`

## What it does not do

- It does not install its own root scripts, approve an unknown or changed
  executable, download \`curl | bash\`, create a new owner signing key or
  sign an unsigned release. The installation phase remains a separate
  signed, owner-controlled operation.
- It does not automatically publish future Seq28+ releases. PR #953
  implements a separate **source-only**, owner-signed monotonic feed rollover
  that needs an independently approved fixed scheduled installation and a
  complete rollback/canary before automation.
- It does not automatically update root Supervisor, gateway, P520 Windows,
  KMJ Main Platform, CloudOS, V3 backups, Docker images or databases.
- No V2 offsite, vault retention, health lines 25/28, nginx, DNS,
  \`gateway.json\` owner/mode or production release pointer changes here.
- Zero additional paid services; local model coding worker remains separate
  and cannot be claimed live without an approved local model and worker loop.

Tests are mock-only Linux fixtures. A merged source PR does not imply that
this root helper is installed, the feed exists, the timer is active, or a
public production deployment succeeded.
