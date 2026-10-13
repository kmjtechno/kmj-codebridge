# CodeBridge — Review a verified isolated repair

An approved deterministic fixing gate may produce a modified detached
worktree. CodeBridge now records a SHA-256 digest of the **exact raw Git diff**
when its independent verification gate succeeds. A read-only MCP tool,
`autopilot_repair_candidate`, lets an authorized project reader check whether
the worktree still contains exactly the same candidate and inspect a bounded,
redacted preview without running commands or publishing code.

## Inputs

- device / project: an authorized enrolled writable project
- task: UUID of a previously verified `auto-repair:RECIPE:SHA` task
- includePatch: optional, false by default; true returns at most 24,000
  characters of redacted preview with an explicit truncation flag

## Hard requirements

The tool rejects the request unless the task is actually waiting at
`VERIFIED_PATCH_AWAITING_REVIEW`, the stored recipe matches an approved
existing recipe, and its lane exists with the exact original commit. The
candidate must pass the same regular-tracked-file and allowlisted-path
checks as the on-device worker. It then compares changed paths, patch
byte count and **full SHA-256** against the durable successful-gate
checkpoint. The preview itself is checked against that digest.

An old screenshot, saved patch, stale task, deleted/reused lane, modified
file, mismatched path, prior failed gate, missing verification job ID or
untrusted unsigned data is **not** accepted as a verified candidate.

The preview uses existing CodeBridge redaction and excludes raw environment
variables or server-side auth tokens. As with all authorized code reading,
a reviewer should still check for source-embedded private material. No
automated publication, force push, merge or deployment is performed.

## Release boundary

The next (separate) approved publication stage should require a fresh
full-digest match, the selected allowed target repository and branch,
fresh CI on the resulting GitHub PR, and owner/reviewer release approval.
This read-only reviewer cannot by itself turn a patch into a live release.

The tool becomes available only after a signed/authorized running agent
upgrade, user/device grant and real MCP smoke check; source merge alone
does not prove live availability.
