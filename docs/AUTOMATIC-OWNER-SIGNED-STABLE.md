# KMJ CodeBridge — automatic owner-signed stable releases

**Status: source-only, NOT installed, NOT enabled on P520.** This feature depends
on the reviewed release CI gate in PR #1051, signed feed publisher PR #1050
and existing immutable GitHub Release workflow. No signing keys go to
GitHub Actions, Cloudflare, Render, Elite VPS, CodeBridge agents or AI tools.

## Automatic path

Once the owner installs the trusted P520 signer and approves its short-lived
private policy, the hourly Windows Scheduled Task does this without a new
PowerShell command for each release:

1. Verify the real GitHub main protection policy: >=1 required approving
   review, enforced admins and strict status checks.
2. Verify current main SHA matches GitHub, the five exact-SHA official
   Actions checks are completed/success, and no additional checks failed.
3. Verify the pinned owner Ed25519 public key and all previous signed
   immutable stable manifests; enforce strictly increasing sequence.
4. Skip release-metadata-only commits so signed PR merges do not trigger
   recursive signing. Refuse a duplicate release branch or a moving main.
5. Build the exact Git source archive WITHOUT running candidate scripts,
   npm hooks or dependencies. Only the installed owner signer has access
   to the locally protected private key; verify signer/key SPKI identity.
6. Sign the immutable manifest and create a reviewable release PR
   automatically. An ambiguous post-sign outcome leaves a sticky lock,
   not an unattended retry.
7. When repository `Allow auto-merge` and squash merges are enabled,
   the signer asks GitHub to queue its signed PR for `--auto --squash`.
   GitHub must still obtain independent required reviewer approval and all
   required status checks before automatically merging; no `--admin`.
   The signer fails BEFORE key use if this repository option is disabled.
8. After the protected automatic merge, the existing GitHub workflow
   publishes the signed immutable GitHub Release automatically. The
   separately reviewed Elite signed-feed publisher and agent auto-updater
   can then safely publish/consume it when independently activated.

**Signing, PR creation and post-review merge are automatic; independent
approval remains a human security gate.** At audit time this repository
reports `allow_auto_merge=false`; its owner must turn on
**Settings > General > Pull Requests > Allow auto-merge** once. Never remove
the independent review rule to obtain automatic merging.

**Key custody trade-off:** unattended signing needs the protected owner key
to be accessible to the owner-host process during a scheduled run. A truly
air-gapped/offline key CANNOT sign automatically. Do not use a cold-storage
root key in the scheduled signer unless the owner explicitly approves
converting it to an online signing key; prefer a separately controlled and
reviewed dedicated signer key with its own trust/rotation process when
available. No key is silently migrated by this PR. No unsigned source, green CI alone, arbitrary
GitHub branch, or AI instruction can bypass these gates.

## One-time owner authorization

Private policy: %USERPROFILE%\.config\kmj-codebridge\auto-sign-policy.json.
Its exact schema contains: schema=1, enabled=true, repo=kmjtechno/kmj-codebridge,
profile=owner-host-auto-sign-stable-only,
ownerConsent=AUTO_SIGN_REVIEWED_MAIN_ONLY, keyId=kmj-release-2026,
approvedAt, expiresAt, maxSequence, repoPath, keyFile, publicKeyFile.
All three paths are absolute. Key files remain outside the source repository.
The approval expires within 30 days, must be renewed by the owner, and
never belongs in a chat, GitHub repository, CI secret or VPS filesystem.
Files require owner-only protected Windows ACLs or POSIX 0600 mode.

After independent exact-head review, use the source-only owner launcher
scripts/windows/ONE-CLICK-OWNER-AUTOSIGN-SETUP-20261118.cmd for the first
P520 installation. If the private policy does not exist, its **separately
Git-blob-pinned local enrollment wizard** asks for one explicit YES, presents
native file pickers for the existing owner private/public Ed25519 files, checks
their private ACL and matching pinned key identity locally, and creates an
owner-only JSON policy valid for 30 days. No private key bytes are printed,
copied, sent to GitHub or saved in the policy. Existing, malformed or expired
policies are never silently replaced; they require owner reconciliation.
The launcher checks exact reviewed Git blob pins and private
policy/key ACL, installs only the trusted signer programs in owner LocalAppData
and registers an hourly, Limited-privilege, single-instance Interactive
Scheduled Task. It neither starts a signing run immediately nor touches
the connected agent, OmniDesk or the owner private key. The task runs only
while the owner P520 is powered on and logged in.

The one-click setup is not an authority to create signing keys, copy the
private key, invent consent, bypass independent review, modify branch
protection, merge PRs, or trigger privileged production deployments.

## Failure handling and release acceptance

- Missing/expired owner policy, loose ACL or mismatched Ed25519 key: BLOCKED.
- Missing independent GitHub review or any red/missing exact-SHA CI: BLOCKED.
- Already current signed code: ALREADY_CURRENT, no key touched.
- Existing release branch / main SHA race: BLOCKED, no overwrite.
- Uncertain remote push or failure after key use: sticky lock; owner reconciles.
- New release is NOT production PASS until signed origin HTTPS bytes, installed
  runtime identity, active agent health, no duplicate device and rollback QA
  are independently verified.

This implementation is new source engineering only; it does not claim
P520 task installation, external signature publication, owner key access
or a live signed release. No extra paid service is needed.
