# KMJ signed stable/latest feed: guarded hourly publisher

**Source-only / NOT installed / NOT enabled.**

KMJ-elite already has an agent-only signed-update timer, but that timer
**consumes** the signed `stable/latest` feed. It does not publish newer signed
releases. The existing owner-verified
`owner_roll_signed_latest_feed_20261115.py` has the publisher and atomic
rollback semantics. This proposal supplies a separate, owner-opt-in systemd
oneshot and hourly timer; it does not sign, build or publish unsigned code.

## Boundaries

- The publishing service runs only the fixed, installed root-owned publisher
  script with fixed `--apply --confirm-owner-signed-rolling-feed`. No caller
  URL, branch, channel, repository, private signing key or arbitrary shell.
- Read-only inputs are the protected public Ed25519 key, immutable signed
  archives, exact HTTP origin and current signed `latest` bytes.
- Write scope is only
  `/var/lib/kmj-codebridge-releases/stable`. ProtectSystem=strict,
  PrivateTmp, PrivateDevices, NoNewPrivileges, empty capability sets and
  systemd resource boundaries are defined in the service.
- Publisher verifies monotonic sequence, genuine owner signature,
  immutable archive hash and exact public HTTPS bytes before an atomic
  `renameat2(RENAME_EXCHANGE)` swap. It preserves the old pair for
  conditional rollback. It never modifies the running gateway, Supervisor,
  CodeBridge agents, production databases or unrelated files.
- The timer runs hourly with five minutes of randomization, keeping host
  cost bounded. The agent's separate signed updater checks more often.
- If the publisher exits with a failure, the fixed
  `kmj-codebridge-signed-feed-roll-trip.service` is triggered through
  `OnFailure`. It disables **only** the publisher timer using one fixed
  systemctl action, preventing blind hourly repeats after an ambiguous
  publication or rollback. It does not stop the agent update timer.
  Re-enable the publisher timer only after owner reconciliation.
- No GitHub CI result, Git push, green PR or unsigned metadata can publish a
  release: the **owner-signed immutable release** is a hard prerequisite.

## Owner-controlled admission

Only after exact-head CI, independent review, source hash pinning, authentic
owner release-key attestation and an isolated dry run should an authorized
owner install all three fixed unit files as root-owned, regular files under
`/etc/systemd/system`. The installed publisher helper must be protected
at the exact fixed path in `/usr/local/libexec/kmj-codebridge` and verified
against its reviewed SHA. After inspecting the effective unit with systemd,
owner may separately enable the hourly timer. Merely merging this PR
**does not** enable, install or restart anything.

The owner must prove that the signed stable/latest origin is publicly
accessible without a Cloudflare challenge and the current signed manifest,
signature and archive are byte-exact. If that origin is blocked, the
publisher safely fails, but an operational BLOCKED status remains.

### Post-install acceptance

1. Systemd effective unit matches exact fixed ExecStart, User=root,
   ReadWritePaths only the signed-feed directory, hardened privileges;
   `NeedDaemonReload=no`.
2. Read-only publisher `--inspect` passes for current and latest signed
   candidate. If there is no newer owner-signed release, an hourly run is
   a verified `ALREADY_CURRENT` no-op.
3. Owner-approved unit run publishes only a strictly higher signed sequence;
   original pair is preserved. Public manifest/signature bytes match local.
4. Existing signed agent updater accepts the owner-signed update and records
   a successful health receipt; forced invalid signatures and downgrades
   remain rejected.
5. A failed HTTPS readback triggers the publisher's guarded rollback without
   deleting old archives. Unrecoverable errors stop rollout and require owner
   reconciliation; no automatic cleanup or stale release fallback.

Physical Elite deployment, public origin readback and live agent health proof
are **not** established by this PR. Windows/P520 agents, Main Platform,
CloudOS and root Supervisor require separate signed release orchestration.
