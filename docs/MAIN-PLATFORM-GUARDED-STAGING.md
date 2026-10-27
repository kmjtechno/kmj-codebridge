# Main Platform guarded staging Supervisor

Status: SOURCE CANDIDATE ONLY. Not installed or live on the VPS. No deployment or production approval follows from source merge.

The owner must install and attest three fixed root-owned, regular, single-linked and non-group/world-writable files:

- /etc/kmj-codebridge/main-platform-staging-approval.json
- /etc/systemd/system/kmj-main-platform-staging-deploy.service
- /usr/local/libexec/kmj-codebridge/kmj-main-platform-staging-deploy.sh

The approval manifest has exactly these keys: schema (kmj.main-platform.staging-approval.v1), approvedSha, expectedCurrentSha, expectedProductionRelease, runnerSha256, unitSha256, backupVerified, rollbackVerified, storageVerified and zeroAdditionalCostVerified. Root-owned approval must be explicitly owner-signed/offline and must not be generated from an AI request. Verify actual backup, rollback and free-only billing guarantees before setting the boolean attestations to true.

The staging Supervisor accepts only the fixed unit after matching immutable runner and systemd unit SHA256 digests, confirming root-owned, non-writable, non-symlink ancestors of all protected files, no systemd drop-in overrides, and `NeedDaemonReload=no` (so the loaded unit matches the reviewed disk state), matching exact staging and production symlinks, requiring active nginx/PHP-FPM and a real stage PHP socket. It accepts no arbitrary path, command, environment, branch, or SSH. It re-checks every gate immediately before systemd start. The user must have execute permission on the exact kmj-elite-main-platform project, a matching approvedSha and expectedCurrentSha, and exact confirmation DEPLOY_APPROVED_STAGING_RELEASE.

The separately owner-installed root-owned unit MUST independently check manifest, exact source branch, protected script hash, backup/rollback/storage, existing stage pointer and concurrency lock, prohibit unreviewed migrations and external paid AI calls, build as nonroot and atomically switch only the staging symlink after validating health. It MUST rollback failed stage cutovers and emit a sanitized receipt. It MUST never modify the production symlink, production database or production DNS.

Read-only tool: supervisor_main_platform_staging_status. Execute-only tool: supervisor_main_platform_staging_deploy. Accepted only means a start was requested, NOT that deployment succeeded. Confirm receipt and independent HTTPS SHA, locked UI/branding and authenticated owner Generate -> Save -> Reopen afterward.

Source CI, runtime rollout, first owner installation and operational verification are separate gates. Nothing in this PR elevates currently enrolled CodeBridge v0.3.2 or installs the unit.
