# KMJ Main Platform staging d32 candidate — NOT INSTALLED

This is a **review-only**, inactive, exact-SHA staging candidate. The files in this folder are **not** a deployed systemd unit, signed approval, production release, or authorization to execute. Do not run old c205/cd503/16e2 candidates against the moved approved branch.

- Main Platform `main` and `staging-approved` at preparation: `d32df111e3a8dae75c8d3321a80f07424c23fe77`
- Last independently observed VPS staging pointer: `9d15e14e39564ffb1e66085a483feb8331f9718f`
- Expected production pointer: `platform-8070dad72c55`; production cutover is **not** included
- `guarded-stage.sh` SHA-256: `5e119d7512a3ca6e33b13bef9ad20d8d43445ed71c2d300f30cb15bb52c07f9b`
- `owner-runner.sh` SHA-256: `0526ec022bdf63468249112a1a9cc44bb11c3d96e1f37021631ab763f09ca13c`
- `owner-staging.service` SHA-256: `9342fbacad8f05d52cde7df5fcf8d9599c3704e09f0edf3e6e48797c48af569a`

## Required independent owner gates

The installed, fixed, root-owned runner path is `/usr/local/libexec/kmj-codebridge/kmj-main-platform-staging-deploy.sh` and the fixed systemd unit is `/etc/systemd/system/kmj-main-platform-staging-deploy.service`. These are **candidate contents only**; no installation is performed here.

The owner must independently verify the latest GitHub approved SHA, actual staging and production pointers, successful offsite backup/restore, rollback, upload storage continuity, PHP socket, and zero-additional-cost billing before any installation. The owner alone must create and approve `/etc/kmj-codebridge/main-platform-staging-approval.json` offline with the exact ten-key schema in `docs/MAIN-PLATFORM-GUARDED-STAGING.md`. Do not auto-generate this manifest, set attestation booleans without evidence, or bypass CodeBridge Supervisor gates.

The offline runner also pins the **exact reviewed systemd unit bytes**, not merely a manifest-provided digest or a substring of `ExecStart`. The isolated negative suite rejects an extra `ExecStart`, `ExecStartPre`, or injected `Environment` even if the manifest digest is recalculated. These tests do not prove installation or live deployment.

The deployed signed CodeBridge runtime must actually advertise `supervisor_main_platform_staging_status` and `supervisor_main_platform_staging_deploy` before using them. A merged PR does not prove the VPS runtime has changed. The staging Supervisor must attest the exact root-owned runner and unit SHA, no writable/symlinked ancestors, no systemd drop-ins, no stale daemon cache, exact current/approved SHA, and explicit owner confirmation.

## Verification and limitations

`tests/staging-d32-candidate-contract.test.js` checks immutable artifact digests, Bash and embedded Python syntax (on Linux), and negative **static contract** mutations. These checks are not a substitute for real root-owned systemd/manifest negative tests, an independent VPS HTTPS exact-SHA readback, or owner-authenticated Generate → Edit → Save → Reopen and artwork review.

The candidate copies the existing staging upload storage and avoids production database migrations, production symlink changes, paid inference, and Cloudflare image API activation. If source or staging pointers move, **stop** and regenerate/review a new candidate; do not alter the approved manifest or reuse an obsolete script. The runner writes a sanitized CodeBridge-readable receipt only after a real owner-authorized attempt. Until then, there is no deployment PASS.
