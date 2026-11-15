# Seq26: fixed CodeBridge operations without repeated root-terminal commands

Status: SOURCE-ONLY DRAFT. This is not a signed Seq26 release, installed tool,
health-check repair, remote backup/restore proof or permission to modify production.

## Implemented

- New read-only MCP action: supervisor_main_platform_local_backup_evidence, scoped
  to kmj-elite-main-platform / kmj-main-platform.
- Backward-compatible run_project_command: command main_platform_local_backup_evidence,
  variant overview. Old clients use an existing execute grant, not an escalation.
- New read-only health unit receipt: direct tool
  supervisor_main_platform_health_unit_receipt and old-client command
  main_platform_health_unit_receipt with overview variant. It checks only
  the exact health-check unit's invocation ID and its journal for the
  KMJ_ELITE_HEALTH_PASS marker, returning no raw journal lines.
  scheduledTimerRunProven always remains false (manual unit invocations
  cannot be mistaken for scheduled timer proof).
- One fixed no-argument Supervisor operation inspects the root-owned daily
  platform.dump and legacy-named age ciphertext + 91-byte sha256 sidecar.
- Read-only: checks name, ownership, file mode, symlink/hardlink, PGDMP magic,
  sidecar spelling and approximate 48h freshness. No DB contents or private
  configuration are read or returned.
- Even when fresh, remoteShaReadbackVerified, exactHealthUnitExitVerified,
  independentRestoreVerified and productionReleaseApproved remain false.
  A health receipt proves the last unit invocation marker/exit only, never
  scheduled triggering, remote recovery or a successful restore.
- The old-client command reconstructs an allowlisted response and suppresses
  unrecognized Supervisor fields.

## Exclusions

NO sudo/bash/sh, caller-selected root shell, binary, path, service, URL, argv,
environment or credentials. NO retention delete, chmod/chown, backup/restore,
mtime changes, scheduled job changes, service restart or release activation.

NEVER change health-check lines 25 or 28 to conceal missing artifacts.
Keep /etc/kmj-codebridge-stage/gateway.json at kmjcode:kmjcode 0600 until the
PR #929 runtime is demonstrably live and can START with a changed config.
Do not replace V2 offsite/Google-X25519 SFTP or claim V3 is installed.

This is observability only. A separate owner-reviewed V3 must retain BOTH
fresh local daily platform.dump AND the Google-X25519 tar.age plus legacy
sidecar after REMOTE_SFTP_SHA_READBACK PASS. Actual acceptance requires
a scheduled backup and the health-check UNIT exit 0 with KMJ_ELITE_HEALTH_PASS
in its own journal; manual replay cannot satisfy that requirement.

## Acceptance before signed Seq26

1. Run exact-head local and integration tests: malformed/unsigned headers,
   missing/stale artifacts, symlink/hardlink, sidecar validation, scope and
   injection denials. The source-only module fixture tests passed 10/10
   locally; integrated Supervisor/dispatcher tests still require execution.
2. Audit installed Supervisor/socket identities and authenticated client
   grants; source merges do not automatically update the captured catalog.
3. Resolve separate release-verifier issue #917 before claiming a signed
   catalog; cryptographic signature, trusted owner key and rollback policy
   are mandatory. Never distribute a private signing key.
4. Prepare owner-signed, SHA-pinned Seq26 bundle with startup-mode preflight
   and reversible signed cutover. Require explicit owner GO.
5. Validate OAuth, tool catalog, device reconnect and seq25 rollback before
   declaring Seq26 production-ready.

## Future fixed-operation candidates (not implemented here)

Bounded health-unit invocation receipt; fixed backup/restore readiness
preview; signing-config startup preflight; retention PREVIEW only; and
non-root exact-HEAD QA through preapproved gates. Every write action needs
its own exact RPC contract, independent tests, owner approval and audit.
No unrestricted root command broker is proposed.
