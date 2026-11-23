# KMJ Elite Fast Release — one root CLI, reviewed adapters

**Status:** Source only until independent GitHub security review, exact-head CI,
immutable SHA verification and explicit owner installation on **KMJ-elite**.
No root installation, signing, release, staging, migrations, activation or
production mutation is implied by source merge.

## Why a universal _interface_, not arbitrary root deployment

`kmj-fast-release` is one fixed command on KMJ-elite. It can operate only on
reviewed, hardcoded project adapters. It **does not** accept a shell command,
repository URL, filesystem path, executable, arbitrary project or branch.

| Project ID | Adapter V1 | Operations |
| --- | --- | --- |
| `main-platform` | Existing pinned owner release helper | `inspect`, `prepare`, `release`, `post-activation` |
| `codebridge` | Existing owner-pinned non-root signer | `inspect`, `sign` (signs PR for review, **not** LIVE) |
| `cloudos` | Not reviewed | Blocked; Google is only for CloudOS testing |
| `omnidesk`, `calibration`, `cinecore` | No reviewed Windows signing/deployment adapter | Blocked |

Each additional project requires a new reviewed adapter and an independently
approved target-specific release policy. This avoids letting one compromised
root dashboard execute arbitrary projects. The dispatcher does not deploy
Windows binaries directly or substitute unsigned artifacts for signed releases.

## One-time trusted installation — owner, root, on KMJ-elite

1. Review the exact CodeBridge merge SHA and the source of `scripts/production/elite_fast_release.py`,
   `scripts/production/elite_fast_release_install.py` and both regression test files.
2. Download the **installer at the reviewed immutable merge SHA**, verify its
   SHA-256 from that independently reviewed commit, then invoke `--inspect`
   using the same `--reviewed-codebridge-sha`. It downloads **only** the
   hardcoded CodeBridge dispatcher (SHA256 pinned inside the installer) and
   Main Platform owner helper at commit
   `7d8cc8d9e5c5a3d94bcaad520674c1e596730470` (SHA256
   `325b24d32ebcf01b42994276a7beb550ed72c69cb044f8ffab03db6f1e218cec`).
3. Run the verified installer a second time with `--apply
   --confirm-elite-root-reviewed-adapters-install` after review. It only
   creates exact root-owned protected files at:
   - `/usr/local/libexec/kmj-fast-release/elite_fast_release.py`
   - `/usr/local/libexec/kmj-fast-release/owner-release-main-platform.sh`
   - `/usr/local/sbin/kmj-fast-release`

   Preexisting untrusted, symlinked, different content or writable paths
   **BLOCK**; no blind overwrite, generic download-execute, service start,
   key handling or configuration mutation.

4. Read the catalogue (no release changes):

   ```bash
   kmj-fast-release --action catalog
   kmj-fast-release --project main-platform --action inspect
   kmj-fast-release --project codebridge --action inspect
   ```

**Important:** This source does not grant an AI assistant arbitrary root
execution. An existing CodeBridge Supervisor cannot install it unless a new
reviewed, privileged fixed-operation capability is separately added and
approved. The owner performs the one-time root installation.

## Main Platform — minimal approved operation

The owner must inspect newest `main` exact SHA and CI first. `prepare` and
`release` revalidate the fixed repository `main` HEAD **twice**, require
fully successful latest GitHub Actions per workflow, and run only the
root-owned SHA-pinned helper. Any missing/failed/in-progress CI, stale HEAD,
missing helper, changed digest, or already-live candidate fails closed or
returns unchanged. Root-only execution is an owner backup/rollback attestation.

```bash
SHA=<approved-40-character-Main-Platform-main-SHA>
kmj-fast-release --project main-platform --action prepare --sha "$SHA" --confirm OWNER_APPROVES_PINNED_FAST_RELEASE
```

For a single owner command that stages and then waits for the independent
activation, choose `--action release` instead of `prepare`. The helper has a
15-minute activation window and will only emit `CHAIN_EXIT=0` after migration.
For normal fast operation, prefer `prepare` (no waiting), activate through the
existing guarded CodeBridge Supervisor after `approvalReady: true`, then:

```bash
kmj-fast-release --project main-platform --action post-activation --sha "$SHA" --confirm OWNER_APPROVES_PINNED_FAST_RELEASE
```

`post-activation` refuses any SHA other than **exactly** the currently live
`platform-<sha12>` and never stages/approves/activates. It is allowed when
GitHub `main` advanced after the approved live cutover. Do not manually
rerun migrations if a previous full chain already printed `CHAIN_EXIT=0`.

## CodeBridge — signed PR, never direct unsigned LIVE

The CodeBridge adapter checks a root-owned immutable signer wrapper and
root-owned Node 24, then drops to the dedicated non-root `kmjsigner` identity.
It first requires `--inspect` to report both
`ELITE_ONEHOST_SIGNER=READY_FOR_OWNER_SIGN` and
`SIGNED_DEPLOY_TIMER=ACTIVE`. If original Ed25519 key custody / protected
29-day owner policy is absent, the operator **fails closed**. It does not
read private key bytes, bypass protected reviews, or install signer artifacts.

```bash
SHA=<approved-40-character-CodeBridge-main-SHA>
kmj-fast-release --project codebridge --action sign --sha "$SHA" --confirm OWNER_APPROVES_PINNED_FAST_RELEASE
```

This creates a signed immutable PR **for independent review**, not a live
CodeBridge release. Only the preexisting root-owned signed auto-release timer
can eventually deploy reviewed signed artifacts and perform guarded rollback.
The existing signed agent-update timer is separate from gateway release.

## Operator rules and evidence

- Run on **KMJ-elite as root** only. Other hosts/identities are rejected.
- A project is not automatically eligible because its source CI passed.
- If `FAST_RELEASE=BLOCKED:*`, stop. Never retry with modified SHA, URL,
  approval, protected GitHub settings, a new key, or another VPS to bypass.
- `MAIN_PLATFORM_ADAPTER_READY_READ_ONLY`, `SIGNED_PR_REVIEW_REQUIRED_NOT_LIVE`
  and CI success are not production release proof. Verify live pointer,
  nginx/PHP-FPM (or CodeBridge gateway/agent), origin HTTPS, migrations,
  signed sequence and independent rollback/recovery receipts.
- No `git reset/clean`, DNS cutover, offsite backup timer changes, private key
  export, accounts cleanup, or unrelated service mutation.

## Regression checks (local source only)

```bash
python3 -B -m unittest discover -s tests -p 'test_elite_fast_release*.py' -v
```

Each release of the protected dispatcher/installer itself requires a new
reviewed immutable source digest and root-owner pin. Neither file is
self-updating; no dynamic project/adaptor registration or unsafe plugins.
