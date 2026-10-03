# Signed immutable updates

KMJ CodeBridge software update is being built as a restricted Supervisor operation, not as arbitrary remote command execution.

## Signed release contract

A release manifest is a small JSON document whose **exact bytes** are signed with Ed25519. The verifier does not reserialize or canonicalize JSON before checking the signature, avoiding ambiguity between publisher and client representations.

Required manifest fields:

- schema = 1
- product = KMJ CodeBridge
- channel = stable or beta
- semantic version
- exact 40-character Git revision
- HTTPS archive URL
- archive SHA-256
- exact archive byte count
- Node.js major version 24
- offset-aware publication timestamp
- signing key id

The signing key id selects one explicitly trusted Ed25519 public key. Unknown keys, non-Ed25519 keys, malformed signatures, modified manifest bytes, archive size changes and archive hash changes all fail closed.

## Archive safety

Before extraction, the updater must list archive members and reject:

- absolute paths
- parent-directory traversal
- Windows-style backslash paths
- NUL-containing or unreasonably large names
- unbounded archive entry counts

The signed archive is still treated as structured input; signature verification does not replace safe extraction.

## Immutable release identity

A verified release directory name is derived only from signed fields:

`<version>-<first-12-revision-hex>`

The final target is constrained to the configured releases root. Remote callers never choose a filesystem path.

## Activation and rollback

The next slice will stage a verified archive into a new immutable release directory, validate the runtime before activation, atomically move the `current` link, retain the previous known-good release, restart through the restricted Supervisor and automatically restore the previous release if health verification fails.

Until that activation slice is merged and live-tested, CodeBridge must not claim production self-update or automatic rollback.
