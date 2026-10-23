# Structured command presets

KMJ CodeBridge keeps project command execution **administrator controlled**. AI clients never submit a raw shell, executable, working directory, environment, timeout, or arbitrary argv.

A project may opt into fixed built-in presets with `commandPresets`. Presets expand during agent configuration validation into the same exact structured command profiles used by `run_project_command`.

Supported presets:

- `node-standard` — locked dependency install plus common test/build/check/lint/typecheck, formatter, and bounded cancellable dev variants.
- `main-platform-ui-ci` — opt-in fixed Main Platform frontend `npm --prefix apps/platform run check`, `types:check`, `build` variants; local source/build evidence only, never license issuance, migration or production deployment.
- `python-standard` — requirements install plus pytest and compile verification.
- `cargo-standard` — locked check/build/test/clippy/format-check plus formatter.
- `windows-python-trial-qa` — explicit Windows-only, project-local Python trial doctor, regression tests, and non-interactive GUI smoke checks. The administrator first installs and reviews `scripts/codebridge-python-trial-qa.mjs` inside an _enrolled calibration project_, and explicitly enables the preset. Never execute this profile in an unrelated repository or elevated/background desktop session.
- `calibration-v4-software-qa` — explicit Calibration Pro V4 `calibration_v4_qa:full` profile invokes the existing `python tools/verify.py` from a clean SHA-pinned detached worktree. It configures/builds/tests both Debug and Release; no projector/camera activation, physical acceptance, candidate promotion, signing, deployment or publishing.
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

No built-in preset exposes `sh`, `bash`, PowerShell, `cmd`, or a generic terminal. Separately, a local administrator may configure [SHA-pinned Windows PowerShell project scripts](WINDOWS-IDE-POWERSHELL-PROFILES.md) as explicit `powershell.exe` build/write profiles. The script path and content digest are fixed at configuration time, and CodeBridge uses an isolated worktree with before-start verification. This does not grant a raw terminal. Repository scripts can still execute project code when the administrator explicitly enables the relevant preset/profile, so untrusted repositories should remain read-only or use stricter isolation.

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

## Calibration Pro: remote QA without repeated PowerShell commands

This preset is a **source change, not a deployed Windows agent**. Before use, the already authorized `kmj-calibration-pro` device must have a verified fresh authenticated connection and its administrator must opt in by setting `"commandPresets": ["calibration-v4-software-qa"]` **only** on that enrolled C++ project. Do not overwrite an existing private agent config from chat, share tokens, alter a second project's scope, or change the separate `kmj-calibration-studio` Python trial profile.

After operator-approved enrollment and project opt-in, the AI client uses CodeBridge tools, not PowerShell:

1. `connection_overview` and `project_snapshot`: require the authorized device/project to be `READY`; read current branch/HEAD/dirty state.
2. `run_project_command`: on the specifically authorized `kmj-calibration-pro` project, select `command="calibration_v4_qa"`, `variant="full"` and a stable `requestKey`; omit `laneId`/`expectedHead`. CodeBridge automatically prepares a clean, detached private worktree from the authorized checkout's exact HEAD, then executes `tools/verify.py` through a fixed command profile. A caller-supplied branch, executable, shell or path is not accepted. For PR #15, the approved checkout must already point to that PR's **actual current head**, not an older test SHA.
3. `get_job_status`: record real job/agent/HEAD/result. Dirty or changed isolated worktrees fail closed, including at delayed job start; local owner work is not cleaned or reset. Any nonzero result blocks SOFTWARE_VERIFIED. Repeating this operation after checkout HEAD changes prepares a new SHA-scoped lane, subject to the existing four-lane quota.
4. A separately preprepared clean lane is also supported by supplying both `laneId` and `expectedHead` explicitly; one missing value refuses execution. If the authorized project is `kmj-calibration-studio` or another repo, this auto-prepare path is unavailable even if its admin enabled a similarly named profile.

**Required safety separation:** Software PASS is not optical or hardware acceptance. Owner-observed 29/29 CTests from another SHA never proves the proposed PR #15 head. Physical T07 must still pass the frozen measured-surface/unmeasured-eligible thresholds, held-out optical verification, identity-bound atomic package promotion, reload and fault-injection, with human operator consent and connected equipment. Failed candidates never replace `release.kmjpkg2`. No automatic merging, hardware scanning, file deletion, self-hosted GitHub runners, paid models or production installation is included.

**Current operational blocker:** If the device is `GATEWAY_REGISTRATION_MISSING`, remote tools cannot install, start, or repair the PC agent. A one-time locally trusted pairing/reconnect and authenticated account-side grant are required; Source/PR creation alone is not connection or production proof.
