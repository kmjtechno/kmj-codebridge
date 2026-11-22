# CodeBridge Release Center — source implementation, phase 1

## One-click staging (implemented after workflow is merged)

Open [Run isolated staging](https://github.com/kmjtechno/kmj-codebridge/actions/workflows/oneclick-stage.yml), select **Run workflow** on **main**. The workflow chooses the immutable current main SHA, checks it against the remote main before and after isolated testing, then runs locked Node 24 install, code check, complete Node tests, runtime packaging and credential scan.

The artifact is a SHA-bound source archive manifest and `stage-receipt.json` with `STAGED_SOURCE_ONLY_OWNER_SIGNATURE_REQUIRED` and `productionMutation=NONE`. It is a seven-day isolated-build staging receipt. **It is not a live KMJ-elite staging server, an owner signature, a signed release or a production deployment.**

The new gate rejects stale HEAD, moving main, symlinks, unsafe archive names, invalid file sizes, mismatched SHA-256 and attempts to label unsigned source as signed. GitHub permission is `contents: read`; no signing key, root token or deploy credentials are given to the runner.

## Minimal owner release path (existing source)

After staging and the official exact-head source CI pass, the owner uses the existing `scripts/RELEASE-CODEBRIDGE.cmd` on the trusted signing PC (not the dirty development checkout). That launcher already does exact-head GitHub CI admission, signature with the original owner Ed25519 private key outside the repository and a protected two-file release metadata PR. Protected review/merge triggers the generic immutable signed GitHub Release publisher.

On KMJ-elite, a **separately installed and approved** `kmj-codebridge-auto-release.timer` can publish the verified signed feed and cut over gateway, applying at most one monotonic signed release per run with rollback. The ordinary signed agent update timer is a different service and **does not prove gateway auto-release is installed**. Do not silently enable either timer or the owner-disabled P520 autosign task.

## Release Center V2: target one-domain UI (not implemented here)

1. **Stage & QA** — the owner-only, rate-limited Main Platform backend sends exactly one GitHub App `workflow_dispatch` for fixed `oneclick-stage.yml`, exact server-verified `main` SHA, with a single-flight lock; no arbitrary ref, workflow or token exposed to the browser.
2. **Approve signed release** — the original owner-controlled key signs locally, or a new separately reviewed delegated signer is explicitly approved. Review/merge remains enforced. Never send the original private key to ChatGPT, GitHub Actions, Cloudflare, Render or the Elite development agent.
3. **Release LIVE** — immutable original owner-signed GitHub artifact → root-trusted Elite publisher/feed → signed updater → fixed gateway cutover → independent tool catalog, authenticated health and rollback readback. No automatic retry after failed cutover.
4. **Proof** — dashboard displays stage SHA, CI, artifact digest, signing/approval, live release, rollback SHA and exact blocker. A button click or host ACK never counts as deployment PASS.

GitHub Actions environment reviewers can assist protected approvals, but the actual repository policy and GitHub plan must first be inspected. Existing CODEOWNER protection cannot be bypassed. Keep Google VPS limited to CloudOS tests. No root control, device re-enrollment, private key migration, account mutation or production deployment occurs from this first source-only PR.

## Verified blockers as of 2026-11-22

- Source `b91bafc192082527654e45ce06518dde54a0405c` has 7/7 official CI success, but the last signed installed stable gateway release is Seq33 (`9584b584...`); there is no newer signed release.
- Dedicated Elite CodeBridge dev agent is still Seq32 with `SUPERVISOR_NOT_CONFIGURED`; do not conflate it with healthy Main Platform gateway Supervisor.
- P520 owner autosign was explicitly disabled; keep disabled without a fresh owner policy. The P520 checkout is stale and contains owner untracked files; never reset, clean or overwrite.
- GitHub source CI and the isolated staging workflow can be green while host Supervisor binding, signing, canary and production release remain unverified.
