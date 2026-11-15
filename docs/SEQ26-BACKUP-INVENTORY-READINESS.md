# Seq26+: fixed local backup inventory and retention preview

STATUS: SOURCE-ONLY candidate. Not signed, installed or deployed. No root shell.

## New fixed capabilities

- MCP read tool: supervisor_main_platform_backup_inventory.
- Captured-client alias: run_project_command command
  main_platform_backup_inventory, variant overview (uses existing execute grant).
- Fixed Supervisor operation: main_platform_backup_inventory, with exactly
  op and no caller-selectable path, unit, retention count or shell arguments.
- Inventory of exact UTC-stamped daily directories and legacy-named
  tar.age / 91-byte sha256 sidecar pairs; PGDMP magic check, owner/mode checks,
  orphan counts, stale freshness, newest pair alignment, no file contents
  beyond the 5-byte PGDMP prefix and 91-byte SHA format.
- Read-only retention PREVIEW for keeping 34 backups, with bounded count and
  maximum three oldest timestamp examples. Keep count is illustrative, NOT
  owner approval of a retention policy, and deletionAuthorized=false.
- Unit-result correlation returns a categorical blocker, not false PASS.

## Security, privacy and proof boundaries

Direct MCP route requires the exact writable authorization for the managed
KMJ-elite Main Platform project, matching Seq26 #932 and #935 fences.
Old-client command rebuilds an allowlisted categorical receipt and drops
unrecognized Supervisor properties, paths, usernames and private data.
An unexpected symlink, bad file mode, orphaned pair or unsafe root fails
closed or disables retention preview. This is NOT a hash verification of
the .tar.age ciphertext against its sidecar: cipherDigestComparedToSidecar
remains false; remote SFTP readback and independent restore remain unverified.

No delete, prune, automatic cleanup, root shell, generic sudo, mtime change,
backup execution, key access, signed release publication, service start,
restart or gateway config permission change occurs.

Do not change /usr/local/sbin/kmj-elite-health-check lines 25 or 28.
Keep /etc/kmj-codebridge-stage/gateway.json at kmjcode:kmjcode 0600 until
exact PR #929-containing runtime is live and startup approved. Offsite V2
must not be replaced by an unreviewed backup writer.

## Activation

CI/tests and merge into GitHub main are source milestones only. The owner
must create a new monotonic signed successor to previously signed sequence
26 with the exact reviewed SHA and trusted Ed25519 key, verify the offline
bundle, validate gateway startup/config and safe rollback, then explicitly
approve production cutover. Existing signed seq26 archive MUST NOT be edited
or replaced under the same sequence. Health-check recovery requires a
separate owner-reviewed dual-artifact V3 writer and an actual scheduled
backup followed by the health-check unit's own successful invocation.
