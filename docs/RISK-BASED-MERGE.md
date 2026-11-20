# Risk-based merge (owner-applied)

Goal: stop asking the owner to approve every pull request while keeping a human
on everything that can change behaviour.

## What the repository now says

`.github/CODEOWNERS` makes **every path owner-reviewed by default**
(`* @nskmedia`). Only plain Markdown under `docs/` has no owner. Code, tests,
scripts, workflows, release metadata, `CLAUDE.md`, `SECURITY.md`, `package*.json`
and config all still need the owner.

## What the owner must change (Claude never edits branch protection)

Settings -> Branches -> rule for `main`:

1. **Required approving reviews: 0** (was 1).
2. **Require review from Code Owners: ON**.

Leave everything else: the five required checks, strict up-to-date,
dismiss stale reviews and "include administrators".

Effect:

| PR touches          | Needs                                                          |
| ------------------- | -------------------------------------------------------------- |
| only `docs/**/*.md` | all five checks green (merged by Claude under CLAUDE.md rules) |
| anything else       | the five checks **and** `@nskmedia` approval, exactly as today |

## Honest limits

- Path-based rules cannot tell a harmless code change from a dangerous one, so
  code stays fully reviewed. Only documentation is automated.
- A Markdown file can still mislead; the checks and the merge audit trail remain.
- Changing `.github/CODEOWNERS` is itself owner-reviewed (it is covered by the
  default rule), so this list cannot widen without the owner.
- If the second setting is not turned on, reviews required = 0 would let any
  PR merge on green checks. **Apply both settings together, or neither.**
- To undo: set required approving reviews back to 1.
