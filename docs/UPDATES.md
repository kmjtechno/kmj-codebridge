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

## Atomic activation state

The current atomic symlink activation adapter is intentionally Linux/POSIX-only. Windows activation fails closed rather than falling back to a non-atomic delete-and-replace sequence; a future Windows implementation must provide equivalent crash-safe switching semantics before it can be enabled.

The immutable activation layer keeps release payloads under a dedicated `releases` directory and manages only two owned symlinks:

- `current` — the active release
- `previous` — the last known-good release

Activation never accepts a caller-selected path. Release names are derived from the signed manifest and must match the exact CodeBridge release-name contract. Before a staged directory can become a release, it must contain the expected CodeBridge package identity/version and runtime entrypoint. Finalization writes a small release marker and atomically renames the staging directory into its deterministic final name.

When activating a new release, the previous active release is recorded first and `current` is then replaced with an atomic symlink rename. Repeating activation of the already-current release is idempotent.

Rollback atomically switches `current` back to `previous` and retains the formerly active release as the new `previous`, allowing bounded flip-back recovery while preserving immutable payload directories.

Release transitions are persisted in a bounded, atomically written history journal under the CodeBridge state directory. Ordinary files or links escaping the managed releases directory fail closed instead of being overwritten.

This layer still does not download or extract archives and does not restart services by itself. Activation therefore remains side-effect-free with respect to service control until the restricted Supervisor integration is present. The Supervisor integration must supply only already signature/hash-verified content and must perform post-switch health verification before considering an update successful.
