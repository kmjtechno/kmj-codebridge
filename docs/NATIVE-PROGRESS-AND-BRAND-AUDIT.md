# CodeBridge native project progress and brand audit

**Purpose:** make Desktop Commander-style operational context available **natively through KMJ CodeBridge**, with no dependency on Desktop Commander or unrestricted remote shell.

## Native project progress

The new `project_progress` read tool is an efficient scoped summary derived from CodeBridge's own durable project job journal and autopilot task journal. It shows task counts, percentages of **tracked tasks**, failed/queued/waiting/running job counts, next dependency-ready task ID, recent bounded job metadata and attention codes.

- It uses existing authorized device/project isolation and the established `read` permission. No global process enumeration, private paths, raw command output or secrets are returned.
- The percentages describe the persisted task subset only. **Whole-product completion is null** and commercial release readiness is `NOT_EVALUATED`, unless a separate independent release verifier provides actual qualifying evidence.
- If no tasks are tracked, percentages are null, not invented 0% or 100%. No paid subscription is automatically required and it does not start autonomous coding jobs.
- Source merge and CI do not upgrade offline Windows agents or refresh an installed ChatGPT app automatically.

## Logo incident response

`node scripts/audit-brand-assets.js` checks that the existing approved CodeBridge `plugin/assets/icon.png` is a valid square PNG and is **byte-for-byte identical** to the packaged Claude icon; ChatGPT `logo`, `logoDark`, `composerIcon`, `composerIconDark`, Claude `icon`, product manifest and existing ChatGPT app-ID references must agree. The report exposes only dimensions and SHA-256 fingerprints.

The approved legacy banner/logo at `plugin/assets/logo.png` is **not replaced or regenerated**. No external image provider is used.

**Important:** A correct GitHub icon/manifest is **not proof that the installed ChatGPT app listing displays the current icon**. The marketplace listing, plugin installation/republication and icon caches are server-side registry state. After the repository audit passes, compare the actual app listing with its icon; if stale, refresh/republish the same authorized app ID through the official connected plugin submission controls. Never silently create a new app or claim the live icon fixed without a verified post-publication check.

## Roadmap and safety

CodeBridge already has native project tree/search/multi-read, guarded edits/moves/copies, bounded commands, sessions/journals, diagnostics, remote supervisor, GitHub CI and mission DAG. The remaining Desktop Commander convenience gaps include privilege-scoped approval UX, native GUI/screen collaboration, richer one-click enrollment and direct customer-friendly dashboards. They require explicit platform permissions, reproducible tests and operator review. Arbitrary root shell, unapproved process killing and unrestricted host filesystem traversal remain intentionally excluded.
