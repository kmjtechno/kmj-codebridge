# KMJ-elite: signing AND deployment on one VPS

**Scope:** KMJ CodeBridge stable release pipeline only. No P520, Google N2 or
another VPS is required *after* owner-controlled signer-key provisioning.
Nothing here applies a Main Platform production approval or fixes offsite SFTP.

## Two identities, one server

- Dedicated **\`kmjsigner\` non-root Linux account** signs reviewed CodeBridge
  stable commits. A protected, expiring 30-day owner policy, exact-SHA GitHub
  CI, independent protected-main reviews, and previously pinned Ed25519 SPKI
  are mandatory. Root, the CodeBridge gateway and development agent cannot
  sign as this identity.
- Existing **root-owned KMJ-elite signed release timer** publishes only already
  owner-signed, merged immutable release manifests, advances the signed feed
  and performs guarded gateway cutover/rollback. It neither reads the private
  signing key nor accepts an arbitrary git branch or uploaded source.
- GitHub remains the signed release *metadata and independent-review* ledger,
  not another signing/deployment server. Neither P520 nor a remote VPS is in
  the release execution path.

This is **not** an authorization to auto-approve unsigned PRs, migrate the P520
private key, sign with root, turn on a new signer schedule, or change protected
main. Signing on an internet-connected host increases the effect of an Elite
compromise. Owner must explicitly approve that key-custody trade-off.

## One-time preparation (not performed by this PR)

1. Owner reviews the exact-head PR and source SHA256s. Use
   \`owner_install_elite_onehost_signer_20261120.py\` on KMJ-elite, in a
   SHA-attested **root-private** reviewed copy: first the default read-only
   preflight; then only with owner's explicit approval,
   \`--apply --confirm-elite-nonroot-signer-owner-go\`.
   The installer creates a dedicated non-login \`kmjsigner\` account if
   absent and copies exactly three hash-pinned files under
   \`/usr/local/libexec/kmj-codebridge-elite-signer/\`. It never reads,
   generates, transfers or prints the private key, and installs no timer.
2. Owner provisions their already trusted **original Ed25519 release key**
   out-of-band into \`kmjsigner\`'s private, mode 0600 key location outside
   any repository. Do **not** send any private key to chat, GitHub, CI,
   CodeBridge project storage, environment variables or an unprotected shell
   history. An unrelated new Ed25519 key will **NOT** work without a
   separately reviewed dual-trust rotation on all deployed clients.
3. Owner configures \`kmjsigner\`'s private 0600
   \`~/.config/kmj-codebridge/auto-sign-policy.json\` with the exact existing
   policy schema (max 30-day validity, protected-main-only owner consent),
   an independently verified public key and an isolated repository checkout.
   Configure GitHub CLI credentials privately for this account using least
   privilege. The signer itself verifies the original pinned owner key
   fingerprint, exact main SHA, protected branch reviews, exact CI, archive,
   history and sequence. No key bytes are logged or transmitted.
4. Owner separately reviews the existing
   \`owner_install_elite_auto_release.py\` root one-time installer.
   The already implemented \`kmj-codebridge-auto-release.timer\` must be
   loaded, enabled and active; the new one-host helper refuses to sign
   when unattended, protected **deployment** is not ready.

## Single-server release execution

From the trusted dedicated signer identity on **KMJ-elite**, execute the
installed root-owned command:

\`\`\`bash
/usr/bin/node /usr/local/libexec/kmj-codebridge-elite-signer/production/elite-onehost-release.mjs --inspect
\`\`\`

Only after \`ELITE_ONEHOST_SIGNER=READY_FOR_OWNER_SIGN\` and
\`SIGNED_DEPLOY_TIMER=ACTIVE\`, owner may explicitly launch:

\`\`\`bash
/usr/bin/node /usr/local/libexec/kmj-codebridge-elite-signer/production/elite-onehost-release.mjs --sign-once
\`\`\`

The wrapper refuses any caller except \`kmjsigner\` on \`KMJ-elite\` with Node24;
verifies the root-owned **exact SHA256** of the installed signer and CI gate,
rejects altered/unreviewed paths and unavailable deployment timer, and
delegates to the existing reviewed owner policy / exact-SHA signer. The signer
only creates an immutable signed release PR and queues GitHub protected
auto-merge; it NEVER self-approves. After independent approval/merge and
GitHub's release artifact checks, the separate root-owned Elite timer
publishes and applies the signature-verified release with rollback.

A successful \`--sign-once\` yields \`ELITE_OWNER_SIGN=REVIEW_GATED\`,
\`ELITE_DEPLOY=SIGNED_TIMER_MANAGED_NOT_ATTESTED\`, **not** \`LIVE_PASS\`.
Proof of actual production deployment still requires real origin HTTPS signed
readback, live gateway/process identity, authorization denials, device health,
release SHA, and rollback readiness.

**Recovery / stop:** Disable only the fixed
\`kmj-codebridge-auto-release.timer\` as owner when a deployment is unsafe;
disable the \`kmjsigner\` execution or expire its owner policy to halt signing.
Keep old signed archives and last-known-good gateway override intact.

**Status as authored:** source engineering / offline QA only; no signer
key is present or migrated by this PR, Elite private policy is not enrolled,
the signer has not run, and no production release/timer mutation is claimed.
