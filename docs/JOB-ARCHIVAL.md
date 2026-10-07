# KMJ CodeBridge durable job archive (Issue #186)

**Status:** proposed in PR #189. This is not a production deployment or a guarantee of continuous unbounded execution. Require exact-head Ubuntu, Windows, Clients and Distribution CI, security review and verified agent rollout before enabling in production.

## Scope and data retention

The native JobRunner retains at most 1,000 **live journal** JSON records by default. When that limit is reached, it attempts to compact only **terminal** jobs (succeeded, failed, cancelled, timed_out, interrupted) down to 70% of the journal budget. Queued and running jobs are never selected. Compaction is synchronous and never launches a new process.

Archived records live in the same private _agent state root_, under job-archive/, not under an authorized project root or GitHub checkout. Each .entry stores minimal job identity, project, requestKey, exact command fingerprint, final state, bounded timestamps and exit metadata. Captured stdout/stderr is **not** archived. The state-root secret .hmac-key is a 32-byte, owner-private key created at first compaction. Entries are HMAC-SHA256 verified on every restart; directory/file type, hardlinks, symlinks and permissions are checked before content is trusted.

Do not export the archive key to ChatGPT or GitHub. HMAC detection protects against inadvertent record modification and a file-only attacker without the key; it cannot provide nonrepudiation against a privileged attacker who compromises the same host and its key. Preserve the state-root backup and key together using approved encrypted backup procedures.

**Idempotency tombstones do not expire automatically.** Silently forgetting an old requestKey could rerun a previously completed write or deployment. The archive has a bounded default maximum of 100,000 records and supports a bounded operator-provided archiveMaxEntries setting (1–1,000,000). When it fills, new archival fails closed (JOB_ARCHIVE_FULL). Removing tombstones must be a separately designed, explicitly authorized, audited procedure that can prove a requestKey can no longer be retried. No automatic age-based deletion is implemented.

## Crash durability and recovery

A terminal job is serialized to a private temporary file, fsynced, atomically renamed to a signed tombstone, and the archive directory synced on POSIX. **Only then** may the original journal file be unlinked and the journal directory synced. After a crash either the source journal or the authenticated tombstone (or both) is present; the duplicate is checked for matching job ID, project, requestKey, fingerprint and state. Replay returns the prior job ID without executing it again. An archived get/result reports the original final state with archived=true, output empty and outputAvailable=false; old logs are not recoverable from the archive.

On corruption, missing HMAC key, unsafe links, exhausted archive capacity or critical resource pressure, fail closed. **Do not** delete or replace the archive key to make a failing instance start. Preserve an immutable copy of the state root, investigate the conflict, and restore only a verified matched backup. Existing independent audit logs are never compacted by this mechanism.

The first compaction creates the archive subdirectory and key. Root-level state permissions and single-writer service ownership remain deployment requirements. On Windows, directory fsync is not available in Node; Windows recovery, permissions and real NTFS ACL enforcement must be reviewed separately before promoting this design to a signed Windows production updater.

## API and operational metrics

- execution_capacity: journalUsed, journalLimit, journalRemaining, plus archiveUsed, archiveLimit, archiveRemaining.
- list_project_jobs: per-project archivedJobs. Its jobs list retains only live journal records; archived job metadata can be obtained by the original job ID.
- Request-key replay remains project-scoped. Reusing a key with a different command fingerprint returns IDEMPOTENCY_CONFLICT.

## Required release checklist

- Exact-head Prettier/check + Node test suite including >1,000 terminal journal records, restart, cross-project lookup, key conflicts, corrupted MAC, missing key, hardlink, archive saturation, active jobs and crash-between-write-and-unlink.
- Ubuntu and Windows CI, client packages and distribution checks all green.
- Verify owner entitlement separately; archival does not grant extra concurrency or device access.
- Back up the current agent state root before supervised rollout; verify restart and eventual rollback, then measure journalUsed and archiveUsed with real traffic.
- Never deploy from a dirty checkout or bypass the signed updater.
