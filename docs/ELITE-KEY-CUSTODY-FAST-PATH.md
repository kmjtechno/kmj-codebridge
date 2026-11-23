# KMJ-elite owner key custody — one-time, pinned fast path

**Source-only pending independent review; not installed, not run, not signed.**
This does NOT replace the protected CodeBridge release policy in
[ELITE-SINGLE-HOST-SIGN-DEPLOY.md](ELITE-SINGLE-HOST-SIGN-DEPLOY.md).

The owner expressly authorized the one-time online key custody change. The
original Ed25519 release private key is still kept on the P520 workstation.
Neither the CodeBridge project agent nor ChatGPT can access that file, and the
key must never be pasted into chat or uploaded to GitHub.

After review/merge and a fresh source SHA check, the Windows operator runs the
reviewed `scripts/windows/KMJ-P520-TO-ELITE-ORIGINAL-KEY-ONECLICK.ps1` on P520,
not on Elite. It checks the existing original key locations, verifies the
**previously pinned** Elite SSH Ed25519 host fingerprint rather than trusting a
new one, and uploads the key pair and SHA-pinned enrollment helper through
strict SSH into a create-only, root-private Elite inbox. An unknown/changed host
key, missing key, symlink, or conflicting inbox blocks without falling back.
The root-private helper then verifies the original Ed25519 SPKI pin, the
non-root `kmjsigner` account, and a SHA-stable isolated source checkout before
creating mode-0600 files and an exact-schema 29-day owner policy. Neither
helper signs, starts a signer timer, approves GitHub reviews, alters Main
Platform production, nor changes the CodeBridge gateway. Previous keys and
policies are never overwritten. Incomplete protected inboxes require manual
owner reconciliation (no silent retry or broad cleanup).

**Owner steps after merge:** Download the verified .ps1 source file (not a ZIP),
review it, verify the exact published SHA-256 against the reviewed merge
commit, and execute it locally on the P520. SSH may prompt for the existing
root credentials; do not provide credentials to any assistant or URL.
Expected success: `ELITE_SSH_HOST_PIN=PASS`, `ORIGINAL_ED25519_PAIR=PINNED_PASS`,
`OWNER_POLICY=CREATED_29_DAY`, `ELITE_ONEHOST_SIGNER=READY_FOR_OWNER_SIGN`,
`SIGNER_ENROLLMENT=PASS_INSPECT_ONLY`, `SIGNING=NOT_STARTED`.

**Next independent security gates:** the owner-controlled `kmjsigner`
`--sign-once` (after exact-head CI), review of the resulting immutable signed
PR, protected merge, the existing signed Elite auto-release timer, and verified
origin/gateway/rollback receipts. Enrollment alone is never LIVE PASS.
