# KMJ P720 — guarded dirty/untracked update without overwriting developer work

The upgraded `UPDATE-P720-CODEBRIDGE.cmd` pins its staged release to
`76ccafd2982a501cfa2a49574a64ffd9afa82f4e`, whose first-party updater source and all required
Windows/Ubuntu CodeBridge PR CI checks passed. The launcher passes both
`-AllowTrackedDirtyCheckout` and `-AllowUntrackedFiles` and still refuses
staged/conflicted/reparse/unsafe inputs. Download the whole reviewed source
tree containing this new launcher and its sibling PowerShell script: an older
ZIP still has the old launcher. A GitHub merge does not update a running
Windows agent.

The first-party `p720-native-agent-update.ps1` now accepts two _separate_
explicit owner opt-ins: `-AllowTrackedDirtyCheckout` for ordinary tracked
unstaged modifications and `-AllowUntrackedFiles` for bounded ordinary files
visible in `git status --porcelain --untracked-files=all`.

For every listed file it snapshots relative name + SHA256 and re-verifies
the same bytes immediately before the single-agent switch and after the
attempt. Untracked files must be ordinary, non-symlink files no larger than
8 MiB each, with safe simple relative names. At most 64 dirty paths are
accepted. Staged changes, conflicts, deleted files, renames, reparse paths,
non-canonical source origins or configuration identity changes are refused.
The switch is blocked while project jobs or Autopilot leases are active.

The updater downloads no model, runs no general shell supplied by a chat,
never resets or cleans the shared project checkout, never touches CineCore,
stages a detached immutable SHA-pinned release, runs locked dependency
installation with scripts disabled and Node checks, full tests and secret
scan. It then restarts only the one enrolled P720 CodeBridge agent when
idle, requires a new authenticated heartbeat, and attempts rollback on
failure. The expected release must be on the allowed origin/main history.

Use only a **reviewed copy of the merged script** at the exact CI-green
commit and a separately verified full target commit. Administrator/operator
must run it locally on P720; current connected MCP supervisor reports
`WINDOWS_UPDATE_NOT_IMPLEMENTED`, so a remote ChatGPT tool cannot activate
it. The command must include both opt-ins if the checkout has both kinds of
changes. Never paste agent tokens, configs, or process command lines.
Successful GitHub CI is not evidence that the actual Windows agent updated.
