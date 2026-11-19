# Artifact SHA-256 receipts (source-only building block)

Status: **opt-in per command-profile variant** (`variants.<name>.artifacts`, schema 1.4).
No preset declares it, so no job produces a receipt unless an administrator adds the field
to their own config. `src/artifact-receipt.js` is unit tested on CI and its only importer is
`src/jobs.js` (a test enforces that). A receipt is stored on the job and returned by
`get_job_status`; it is **not** proven on any device yet.

## Job runner integration

`JobRunner.run({ ..., artifacts: { include: [...] } })` (default `null` = unchanged):

- Validated at submit time (1-64 string entries, else `INVALID_ARTIFACT_SPEC`). The list is
  part of the idempotency fingerprint only when present, so existing jobs and keys are
  unaffected.
- Hashing happens only after a job ends `succeeded`, rooted at the job's `cwd`. Failed,
  cancelled and timed-out jobs get no receipt.
- Success stores a small summary on the job (`version`, `include`, `totalFiles`,
  `totalBytes`, `receiptSha256`). It is verifiable by rebuilding the receipt from the same
  include list and comparing `receiptSha256`; the per-file list is not stored, which keeps
  the journal record under its 131072-byte cap.
- A receipt failure is stored as `artifactReceiptError` (an `ARTIFACT_*` code) and never
  changes the job state or exit code.
- The durable archive record is fixed-shape, so the receipt is not kept once a job is
  archived. Persisting it there needs a separate archive-format change.

## What it does

`buildArtifactReceipt({ root, include, limits })` hashes a closed list of files under one
absolute root and returns a receipt:

```json
{
  "version": 1,
  "algorithm": "sha256",
  "include": ["out"],
  "files": [{ "path": "out/app.bin", "size": 8, "sha256": "..." }],
  "totalFiles": 1,
  "totalBytes": 8,
  "receiptSha256": "..."
}
```

`receiptSha256` is the SHA-256 of the canonical JSON of `version`, `algorithm`, `include`
and `files`. It has no timestamp and no absolute path, so the same tree always gives the
same receipt and a receipt can be shared without leaking the host layout.

`verifyArtifactReceipt(receipt, { root })` first checks that the receipt is well formed and
that its own hash matches its body, then rebuilds it from the same include list and
reports `modified`, `missing` and `added` files. A mismatch is a result, never a throw.

## Deny-by-default rules (Enforced by the module)

- The caller supplies relative file or directory names only. Empty, absolute, drive-letter,
  `..`, `.`, empty-segment, trailing dot or space, control character, `: * ? " < > |`
  entries are refused with `ARTIFACT_PATH_INVALID`. Both `/` and `\` are accepted and
  normalised.
- No symlink is ever followed, as the entry, inside a directory or as a parent
  (`ARTIFACT_SYMLINK_REFUSED`, `ARTIFACT_OUTSIDE_ROOT`). The root must be a real
  directory (`ARTIFACT_ROOT_INVALID`).
- Only regular files. FIFOs, sockets and devices are `ARTIFACT_NOT_REGULAR`. Nothing is
  silently skipped: one unsupported entry fails the whole receipt.
- Hard ceilings, which a caller may lower but never raise: 64 include entries, 2000 files,
  1 GiB per file, 4 GiB in total, depth 12, path length 260. An empty result is refused
  (`ARTIFACT_EMPTY`) so a vacuous receipt cannot look like proof.
- Each file is opened without following links and compared with its earlier `lstat`
  (device, inode, size). A file that changes while it is read fails with
  `ARTIFACT_CHANGED_WHILE_HASHING`.

## What it does not claim

- It proves nothing about how the files were produced, only what the bytes were when
  hashed. It is not a signature and does not authenticate the host.
- Receipts are not yet stored, returned by a tool or tied to a job id, a lane head or a
  command profile. That wiring needs owner review.
- Hard links are hashed like any regular file. NTFS junctions and Windows reparse points
  other than symlinks are not specifically tested.
- Verification detects added files only under the original include list.
