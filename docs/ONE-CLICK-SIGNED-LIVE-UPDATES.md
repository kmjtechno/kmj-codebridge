# KMJ TECHNO - One-Click Signed Live Updates (P0)

## Current reality

The existing CodeBridge agent has a signed stable updater and systemd timer.
Its installer schedules the timer from OnBootSec=2min, OnUnitInactiveSec=5min,
with bounded jitter. The signed timer was observed DISABLED on KMJ-elite on
15 November 2026.

The stable agent updater cryptographically checks the owner Ed25519 signature,
archive SHA256/size, monotonic release sequence, runtime compatibility and its
own authenticated health/rollback. It does NOT automatically promote the
KMJ-elite gateway, privileged Supervisor, Windows P520 agents, Main Platform,
CloudOS or backups. This PR must never claim those components auto-deploy.

## One-click controller

scripts/production/owner_oneclick_signed_autoupdate.py supports only:

- --status (read only)
- --enable --confirm-signed-auto-owner-go
- --disable --confirm-signed-auto-owner-go

It accepts no caller path, URL, channel, unit or executable.

An active systemd timer is **not** sufficient to claim a working updater.
Read-only status for an active timer checks that both URLs reference the pinned
rolling `stable/latest` feed, downloads the exact pair, and verifies the
owner's Ed25519 signature before reporting `ONECLICK_AUTO_SIGNED=ENABLED`.
An invalid or unreachable signed feed returns a bounded blocker instead of
an optimistic success. Disabling the timer also requires an exact systemd
readback (`UnitFileState=disabled`, `ActiveState=inactive`); a successful
`systemctl` return code alone does not prove a disabled timer.

When first switching the updater config to the signed rolling feed, the
helper now persists its protected rollback backup with a full-write loop,
file fsync, **parent-directory fsync**, and byte-for-byte readback before
replacing the original config. A pre-existing or partial backup is never
silently deleted; owner reconciliation is required before another attempt.
Before enable, it enforces a root-owned approval file, fixed stable-agent
scope, pinned owner public SPKI, signed _latest-feed_ bytes, precise
config and service unit policy, and no development-timer conflict. It
migrates only manifestUrl and signatureUrl from the exact Seq27 immutable
release URLs to the fixed stable latest feed, retaining a private original
config backup. Failure to enable stops the newly enabled timer and restores
the prior config, or retains a blocker if rollback cannot be proved.

The signed latest feed must be served under:
https://kmjtechno.com/codebridge/releases/stable/latest/release-manifest.json
https://kmjtechno.com/codebridge/releases/stable/latest/release-manifest.sig

DO NOT assume these endpoints exist. An independently approved signing
publisher first uploads complete immutable archive and manifest/signature,
then changes these two feed files after external verification. An in-between
pair mismatch fails cryptographic verification until the next check. Never
accept an unsigned latest.json, GitHub branch, stale sequence or new key
obtained from unsigned metadata.

## One-time owner installation (not executed by this PR)

Only after exact-head CI, security review and a trusted signed operator
bundle, install the helper as a root-owned regular file at:
/usr/local/libexec/kmj-codebridge/owner_oneclick_signed_autoupdate.py

The owner provisions a private 0600 root-owned approval file at:
/etc/kmj-codebridge-oneclick/signed-auto-update-approval.json

Contents must have exactly the following object, no extra keys:

    {
      "schema": 1,
      "profile": "signed-stable-agent-only",
      "allowedComponents": ["agent"],
      "keySpkiSha256": "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8",
      "minimumSequence": 27,
      "ownerGo": true
    }

This authorizes future owner-signed stable _agent_ releases only. No
private signing key is required or written on the managed device.

The owner then uses ONE command to enable ongoing checks:

    sudo /usr/bin/python3 -I -B /usr/local/libexec/kmj-codebridge/owner_oneclick_signed_autoupdate.py --enable --confirm-signed-auto-owner-go

Or to inspect/disable:

    sudo /usr/bin/python3 -I -B /usr/local/libexec/kmj-codebridge/owner_oneclick_signed_autoupdate.py --status
    sudo /usr/bin/python3 -I -B /usr/local/libexec/kmj-codebridge/owner_oneclick_signed_autoupdate.py --disable --confirm-signed-auto-owner-go

A future already signed+installed fixed CodeBridge Supervisor profile may
make these controls one-click in Main Platform. Do NOT add generic root
shell, arbitrary sudo, remote installer URL, or new privileged functions
without a reviewed policy, audit and owner consent.

## Per-release automation gates

1. Exact-head source review and offline/Windows/Linux tests, avoiding extra
   paid GitHub CI when owner quota is exhausted.
2. Immutable artifact with exact Git SHA, archive hash/bytes and monotonic
   release sequence; independent owner-controlled signature outside repo.
3. Publish immutable files; verify signed latest-feed manifest and detached
   signature. Client trusts only pinned Ed25519 owner public key and current
   stable channel.
4. Existing on-device signed timer checks approximately every five minutes
   plus jitter while host is running. Anti-rollback and authenticated agent
   health control activation/rollback. It never watches unsigned Git main.
5. Collect actual device/MCP receipts and scoped-denial tests. Additional
   components require a separate signed, transactional orchestration release.

Not complete from this source PR: installation/enablement on KMJ-elite,
public latest-feed publication, signer custody, root Supervisor/gateway
automatic promotion, signed Windows auto-upgrade or live rollback drill.

## Important separate production blockers

Direct Seq27 CodeBridge read-only receipts now work after owner PR946 repair,
but the local daily/vault stamp 20261111T091303Z is stale, health unit exits
1, and the vault-root has 10 unrelated entries not classified by the bounded
MCP response. Do not delete them. A separately owner-reviewed V3 dual-artifact
writer, actual scheduled backup and own-invocation health PASS are required.
Preserve X25519 V2, gateway.json owner/mode and health lines 25/28.
