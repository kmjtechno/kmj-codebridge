# Structured command presets

KMJ CodeBridge keeps project command execution **administrator controlled**. AI clients never submit a raw shell, executable, working directory, environment, timeout, or arbitrary argv.

A project may opt into fixed built-in presets with `commandPresets`. Presets expand during agent configuration validation into the same exact structured command profiles used by `run_project_command`.

Supported presets:

- `node-standard` — locked dependency install plus common test/build/check/lint/typecheck, formatter, and bounded cancellable dev variants.
- `main-platform-ui-ci` — opt-in fixed Main Platform frontend `npm --prefix apps/platform run check`, `types:check`, `build` variants; local source/build evidence only, never license issuance, migration or production deployment.
- `python-standard` — requirements install plus pytest and compile verification.
- `cargo-standard` — locked check/build/test/clippy/format-check plus formatter.
- `windows-python-trial-qa` — explicit Windows-only, project-local Python trial doctor, regression tests, and non-interactive GUI smoke checks. The administrator first installs and reviews `scripts/codebridge-python-trial-qa.mjs` inside an _enrolled calibration project_, and explicitly enables the preset. Never execute this profile in an unrelated repository or elevated/background desktop session.
- `go-standard` — test/vet/build plus formatter.
- `cmake-standard` — configure into the fixed `.kmj-codebridge-build` directory, Debug/Release build and CTest with bounded parallelism. It never installs, publishes or signs.

Example:

```json
{
  "id": "project1",
  "root": "/srv/project",
  "writable": true,
  "gates": {},
  "commandPresets": ["node-standard"],
  "commands": {}
}
```

Presets are opt-in. They do not inspect package metadata, execute automatically, or turn repository scripts into new permissions. An explicit administrator command with the same profile ID overrides the preset. Runtime execution remains project-root confined, bounded by the job runner, cancellable, redacted, audited, and subject to the existing risk policy.

No preset exposes `sh`, `bash`, PowerShell, `cmd`, or a generic terminal. Repository scripts can still execute project code when the administrator explicitly enables the relevant preset/profile, so untrusted repositories should remain read-only or use stricter isolation.

## Isolated worktree execution

`run_project_command` and `run_quality_gate` accept an optional `laneId`. When set, the
exact profile runs inside a worktree that `worktree_lane_prepare` already created for
that project and pinned to an expected `HEAD`, rather than the shared checkout. An
unknown lane fails with `WORKTREE_NOT_FOUND`; the lane id follows the same strict
grammar as the lane tools, so it cannot carry a path. The job label records the lane
(for example `command:cmake_build:release:build@ci-lane`) so receipts show where a
build ran. Use a lane on any device whose shared checkout holds uncommitted work.

## $0 hosted-CI outage recovery without self-hosted runners

1. Verify `github_actions_execution_doctor` with the **live PR number**, exact current 40-character PR head and GitHub Actions run ID. A recorded failed job with `steps: []` is `FAILED_WITH_ZERO_JOB_STEPS`, **not an application test failure**. Missing step arrays are `STEPS_UNKNOWN`, not zero.
2. An authorized agent administrator may explicitly enable `"commandPresets": ["main-platform-ui-ci"]` for the already approved `kmj-main-platform` project. This does **not** turn on profiles for existing installations by itself, install a runner, install dependencies, change production secrets or start jobs.
3. **Only** after preparing a clean, separate, SHA-pinned worktree with `worktree_lane_prepare`, invoke the fixed `main_platform_ui_ci` `check`, `types`, and `build` variants through `run_project_command` using the prepared `laneId` and exact `expectedHead` SHA. The dispatcher rejects dirty or moved lanes and repeats this check immediately before a queued process starts. The persisted job label includes the expected SHA. This is a prelaunch check within a trusted agent identity, not isolation from a hostile process running as the same OS user. If the installed gateway/client version does not expose `laneId`, do not fall back to the live checkout. Prefer a separate testing machine to the production web VPS.
4. Check job receipts via `get_job_status`. Persist a minimal redacted receipt with the actual local commit SHA, tool command profile, start/end, exit code, job ID and agent/device; any nonzero, missing or timeout result blocks acceptance. Never describe this as hosted GitHub Actions or Windows/browser/PHP testing.
5. GitHub branch protection and exact-head required checks **remain enforced**. Local verification cannot turn a hosted failed run into green, cannot be merged as a substitute for required GitHub checks, and cannot identify the GitHub vendor billing/runner root cause by itself.

No auto-rerun loop, no metered compute purchase, no GitHub Actions self-hosted runner registration, no shell profile and no payment/database/deploy commands. Existing hardware has its own electricity/network costs; "$0" here means **no additional provider CI charges**.

## KMJ Calibration Studio trial on Windows P720

**First repair the interpreter discovery:** an online CodeBridge agent cannot make
`D:\\KMJ-Calibration-Lab-UV\\.venv\\Scripts\\python.exe` appear on disk.
The independently released calibration trial has its own read-only Python
resolver and opt-in `uv` bootstrap. Run it locally in an interactive Windows
user session and confirm the GUI before adding remote QA.

For unattended, bounded project-only verification, enroll the **separate**
KMJ Calibration Studio source tree as an authorized project root, then
configure just `"commandPresets": ["windows-python-trial-qa"]` on that project.
The approved project must contain a reviewed
`scripts/codebridge-python-trial-qa.mjs` that accepts only:
`doctor` (read-only interpreter check), `tests` (local regression tests), and
`smoke` (non-interactive GUI smoke test). The AI client cannot specify an
executable, cwd, environment, device path, Python arguments or shell command.
The runner uses bounded job timeouts, redaction and job receipts.

No installer, arbitrary file access, device-level GUI control, webcam activation,
projector output, screen capture, credential exposure, code signing or publish
is granted by this preset. The agent may run in Windows Session 0, so an
interactive GUI **must** be launched locally by the signed-in operator using
`OPEN-GUI.cmd`. A headless smoke failure on Session 0 is not proof the desktop
app fails in the user's graphical session.

Current deployment requires the agent's administrator to opt in and restart
the pinned device runtime after review. Adding this source preset alone does
not modify an installed agent, grant a project, or deploy a gateway.
