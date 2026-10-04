# Signed immutable updates

KMJ CodeBridge software update is being built as a restricted Supervisor operation, not as arbitrary remote command execution.

## Signed release contract

A release manifest is a small JSON document whose **exact bytes** are signed with Ed25519. The verifier does not reserialize or canonicalize JSON before checking the signature, avoiding ambiguity between publisher and client representations.

Required manifest fields:

- schema = 1
- product = KMJ CodeBridge
- channel = stable or beta
- monotonically increasing release sequence
- semantic version
- exact 40-character Git revision
- HTTPS archive URL
- archive SHA-256
- exact archive byte count
- Node.js major version 24
- offset-aware publication timestamp
- signing key id

The signing key id selects one explicitly trusted Ed25519 public key. Unknown keys, non-Ed25519 keys, malformed signatures, modified manifest bytes, archive size changes and archive hash changes all fail closed.

## Archive download and extraction safety

The updater now includes a fail-closed archive downloader and extractor foundation. It resolves the signed archive hostname before connecting, accepts only public IPv4 answers for this initial implementation, pins the HTTPS connection to the validated address, refuses redirects and compressed HTTP content, and requires the exact signed byte count and SHA-256 before the archive is accepted. Mixed public/private DNS answers fail closed; IPv6 is intentionally unsupported until equivalent address-classification coverage is implemented.

Before extraction, the updater lists archive members and rejects:

- absolute paths or parent-directory traversal
- Windows-style backslash paths
- NUL-containing or unreasonably large names
- duplicate or unbounded archive entries
- symlinks, hardlinks and other non-regular/non-directory archive members
- archives that do not contain exactly one expected `kmj-codebridge-<version>-<revision>` root with `package.json` and `src/cli.js`

Extraction uses the system `tar` executable without a shell, strips only the verified release root, disables archive owner/permission restoration, requires an empty real staging directory, and re-walks the extracted tree to reject symlinks and hardlinked files before it can be handed to `ReleaseStore.finalize()`.

The signed archive is still treated as structured input; signature verification does not replace safe extraction.

## Immutable release identity

A verified release directory name is derived only from signed fields:

`<version>-<first-12-revision-hex>`

The final target is constrained to the configured releases root. Remote callers never choose a filesystem path.

## Activation and rollback

Verified download, safe extraction, immutable staging/finalization, atomic `current`/`previous` activation and local rollback primitives are now implemented as separate fail-closed layers. The remaining production slice must compose them with configured manifest/signature retrieval, preflight dependency/runtime validation, restricted Supervisor restart, post-switch authenticated connectivity/health verification and automatic restoration of the previous release on failure.

Until that end-to-end orchestration is merged and live-tested, CodeBridge must not claim production self-update or automatic rollback.

## Atomic activation state

The current atomic symlink activation adapter is intentionally Linux/POSIX-only. Windows activation fails closed rather than falling back to a non-atomic delete-and-replace sequence; a future Windows implementation must provide equivalent crash-safe switching semantics before it can be enabled.

The immutable activation layer keeps release payloads under a dedicated `releases` directory and manages only two owned symlinks:

- `current` — the active release
- `previous` — the last known-good release

Activation never accepts a caller-selected path. Release names are derived from the signed manifest and must match the exact CodeBridge release-name contract. Before a staged directory can become a release, it must contain the expected CodeBridge package identity/version and runtime entrypoint. Finalization writes a small release marker and atomically renames the staging directory into its deterministic final name.

When activating a new release, the previous active release is recorded first and `current` is then replaced with an atomic symlink rename. Repeating activation of the already-current release is idempotent.

Rollback atomically switches `current` back to `previous` and retains the formerly active release as the new `previous`, allowing bounded flip-back recovery while preserving immutable payload directories.

Release transitions are persisted in a bounded, atomically written history journal under the CodeBridge state directory. Ordinary files or links escaping the managed releases directory fail closed instead of being overwritten.

The update layer can now download and safely extract a signed runtime archive foundation, but it still does not restart services by itself. Production orchestration must pass only signature/hash-verified, safely extracted content into immutable finalization/activation and must perform preflight plus post-switch service/connectivity health verification before considering an update successful.

## Anti-rollback and release signing

Normal remote updates require a signed `sequence` strictly greater than the highest sequence already accepted by the updater. A previously valid older release therefore cannot be replayed through the update channel. Explicit rollback remains a separate local operation that can activate only the locally recorded previous-known-good release.

Release archive URLs must use HTTPS and may not target literal localhost, private/link-local IPv4, literal IPv6, `.localhost` or `.local` hosts. The downloader additionally resolves the hostname itself, rejects non-public or mixed public/private IPv4 answers, and pins the HTTPS request to the accepted public IPv4 address so a second resolver lookup cannot redirect the connection into a private range. Redirects are refused rather than followed.

The build host can create the exact signed manifest expected by the runtime verifier without exposing the private key to customer devices:

```sh
CODEBRIDGE_RELEASE_KEY_FILE=/secure/kmj-codebridge-release-ed25519.pem \
CODEBRIDGE_RELEASE_KID=release-2026 \
npm run sign:runtime -- \
  dist/runtime/manifest.json \
  https://releases.kmjtechno.com/codebridge/<archive>.tar.gz \
  42
```

The signer refuses a private key stored inside the checked-out repository. The runtime receives only the signed manifest, detached base64url signature and configured trusted public keys.
