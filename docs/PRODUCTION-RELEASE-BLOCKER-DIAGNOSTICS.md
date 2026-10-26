# Main Platform production release blockers (safe diagnostics)

The root Supervisor's existing fixed, read-only
`supervisor_main_platform_production_status` response now has an additional
`activationBlockers` array of fixed codes. It **never** modifies a protected
approval manifest, calls a deployment command, or infers a backup exists from
a release pointer alone. Existing `readyToActivate` semantics are unchanged.

Possible codes:

- `PROTECTED_APPROVAL_MISSING_OR_INVALID`: root-owned approval is missing
  or violates its existing identity / syntax / backup flags.
- `CURRENT_RELEASE_INVALID`: fixed live symlink is absent or not an approved
  release pathname.
- `PROTECTED_EXPECTED_CURRENT_RELEASE_MISMATCH`: current live release does
  not match the protected approval's old release. The operator must **not**
  force the symlink or overwrite the approval file; prepare a newly verified
  exact-SHA candidate, backup, independent restore and protected authorization.
- `RELEASE_UNIT_NOT_INSTALLED`: fixed privileged release unit unavailable.
- `RELEASE_UNIT_NOT_IDLE`: installed release unit is not inactive.
- `NGINX_NOT_ACTIVE`, `PHP_FPM_NOT_ACTIVE`: core web services unhealthy.

These codes are **source-only until the separately authorized CodeBridge
supervisor runtime is updated**. An empty array is only the preflight's
bounded consistency check, **not** proof of all customer QA, full backup,
offsite recovery, or live activation. Always require exact candidate SHA,
current release readback, independent backup/restore tests, authenticated
owner-browser approval, and fixed guarded activation unit.

Observed 26 Oct 2026 Main Platform preflight: current
`platform-8070dad72c55`, expected
`platform-54142f844c0b`, active Nginx/PHP, protected SHA
`8070dad72c551e5e13d1a78b0d4e6933c2d2ae9b`,
`readyToActivate=false`. This cannot be repaired safely using a new
diagnostics field. Do **not** represent a GitHub merge as production deployment.

Gateway config doctor caveat: an active alternate gateway service may use
a separately configured private config path. `CONFIG_FILE_MISSING`
describes the doctor's fixed file path, not proof the active gateway is down;
the active gateway's real process and bounded health must be checked
independently. Do not copy any private configs/tokens to satisfy the doctor.
