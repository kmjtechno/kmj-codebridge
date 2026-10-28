# Main Platform operator recovery status (read-only source candidate)

This change makes the existing `supervisor_main_platform_maintenance_status` report one additional fixed, root-owned systemd unit named `kmj-28545-local-backup-restore-20261028.service`. It exists solely to diagnose an owner-submitted backup/restore attempt for immutable Main Platform candidate `28545ebee1b686726598773349d182168cf4b740`.

## Precise trust boundary

- The owner recovery unit is **not installed or launched** by this source change. The production Main Platform application, backup archives, credentials and live release are not modified.
- Root Supervisor uses a **literal, immutable service name**, never a caller-provided unit, shell command, Git ref, path, environment or source. Only the fixed `systemctl show` properties already sanitized by `fixedUnitStatus` are exposed.
- `ownerRecovery` describes systemd's bounded observed state, including `installed`, `activeState`, `result`, and `execMainStatus`. It is **not** backup evidence. `--collect` transient services may disappear when finished; in that case an absent unit is inconclusive.
- `ownerRecoveryReceiptVerified=false`, `recentBackupVerified=false`, `restoreVerified=false`, and `productionReleaseApprovedByThisCheck=false` remain false even when systemd says `success`. No independent archive hashing, PostgreSQL restore or offsite decryption is performed.
- A separate authorized, secret-free `work/qa/KMJ_28545_OVERNIGHT_ROOT_RECOVERY_20261028.txt` receipt and SHA-matched archive/witness must be verified independently before local recovery credit. A result of `FILE_NOT_FOUND` is **unverified**, not PASS.
- Source-only changes to CodeBridge do not update its deployed agent. The enrolled KMJ-elite agent must undergo its normal owner-signed, immutable release canary and rollback before the additional status can be called.

## Why not generic root access?

The enrolled CodeBridge user's existing Supervisor is a fixed-operation broker. It intentionally has **no unrestricted root shell**, no arbitrary `sudo`, no caller-provided systemd unit names, and no production approval mutation. To eliminate repeated root commands, a future independently reviewed and owner-installed fixed backup systemd unit plus a typed SHA-bound start operation is needed; this read-only field does not purport to supply that.

Never substitute a prior candidate's backup for the exact target, or force-edit a protected approval manifest to turn `readyToActivate=false` into a green status.
