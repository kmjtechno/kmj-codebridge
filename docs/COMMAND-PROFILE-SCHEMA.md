# Command-profile schema and compatibility matrix

Document version: **1.1** (2026-11-12). Milestone: **M0 inventory/contracts** of
`docs/UNIVERSAL-LOCAL-DEVELOPMENT-ENGINE.md`.

This documents the contract that the code enforces **today**. It adds no new
capability. The source of truth is the code; `tests/command-profile-contract.test.js`
fails if the preset list below drifts from `src/command-presets.js`.

Status labels: **Enforced** = checked by code in this repository. **Pending** =
not proven on a real device; see "What is not claimed".

## 1. Deny-by-default rules (Enforced)

1. A command runs only if an administrator put it in the project's `commands`
   config (directly or through `commandPresets`). Nothing is allowed by default.
2. `run_project_command` takes a profile id and a **variant name** only. The caller
   cannot supply an executable, arguments, environment, working directory or shell
   text. Unknown profile or variant -> `COMMAND_NOT_ALLOWED`.
3. Argv and timeout are fixed by config. The job gets that argv, never a shell string.
4. A non-`inspect` category on a project that is not writable -> `READ_ONLY_PROJECT`.
5. Explicit `commands` entries override a preset with the same id (`expandCommandPresets`).
   An unknown preset id fails config load (`UNKNOWN_COMMAND_PRESET`).
6. Profiles in `commandRequiresIsolatedLane` (`main_platform_ui_ci`,
   `calibration_v4_qa`, `calibration_studio_qt_qa`, `vioso_rig_preflight`) run only in a SHA-pinned isolated
   worktree lane, never in the main checkout. Pinned lanes require `laneId` and
   `expectedHead`; head mismatch or dirty lane is refused and re-verified in the
   `beforeStart` hook.
7. A profile with a pinned `powershellScript {path, sha256}` is re-hashed before
   start; a changed file -> `POWERSHELL_SCRIPT_CHANGED_BEFORE_START`.

## 2. Profile schema (config `commands.<id>`)

| Field                       | Type / limit                                 |
| --------------------------- | -------------------------------------------- |
| `category`                  | `inspect` \| `build` \| `write` \| `network` |
| `description`               | string, <= 160 chars                         |
| `command`                   | string, <= 260 chars, no control characters  |
| `variants.<name>.args`      | array, <= 32 items, each <= 512 chars        |
| `variants.<name>.timeoutMs` | integer 10..300000 (default 30000)           |
| `powershellScript`          | optional `{ path, sha256 }`, pinned          |

Risk mapping: `inspect`->READ, `build`->TEST, `write`->EDIT, `network`->SERVICE;
anything else -> PRIVILEGED. `approvalRequired` applies only to DEPLOY, PRIVILEGED
and DESTRUCTIVE risk.

The config has no explicit `schemaVersion` field yet; versioning is by this
document and the drift test. Adding a machine-readable `schemaVersion` is a
separate, backward-compatible change and is not done here.

## 3. Reason codes (Enforced)

`COMMAND_NOT_ALLOWED`, `READ_ONLY_PROJECT`, `WORKTREE_LANE_REQUIRED`,
`WORKTREE_EXPECTED_HEAD_REQUIRED`, `WORKTREE_NOT_FOUND`, `WORKTREE_HEAD_MISMATCH`,
`WORKTREE_HAS_UNSAVED_WORK`, `POWERSHELL_SCRIPT_CHANGED_BEFORE_START`,
`WORKTREE_PHP_VENDOR_NOT_INSTALLED`.

## 4. Preset compatibility matrix

Timeouts are per variant, in ms. "Lane" = must run in a pinned isolated lane.

| Preset                          | Profile id                 | Category | Executable                   | Variants (timeout)                                                      | Lane    |
| ------------------------------- | -------------------------- | -------- | ---------------------------- | ----------------------------------------------------------------------- | ------- |
| `node-standard`                 | `node_deps`                | network  | `npm`                        | `locked` = `ci` (300000)                                                | no      |
| `node-standard`                 | `node_verify`              | build    | `npm`                        | `test`, `build`, `check`, `lint`, `typecheck` (300000)                  | no      |
| `node-standard`                 | `node_format`              | write    | `npm`                        | `write` = `run format` (300000)                                         | no      |
| `node-standard`                 | `node_dev`                 | build    | `npm`                        | `start` = `run dev` (300000)                                            | no      |
| `main-platform-ui-ci`           | `main_platform_ui_ci`      | build    | `npm`                        | `check`, `types`, `build` under `--prefix apps/platform` (300000)       | **yes** |
| `python-standard`               | `python_deps`              | network  | `python3`                    | `requirements` (300000)                                                 | no      |
| `python-standard`               | `python_verify`            | build    | `python3`                    | `test` (pytest), `compile` (300000)                                     | no      |
| `cargo-standard`                | `cargo_verify`             | build    | `cargo`                      | `check`, `build`, `test`, `clippy`, `format_check` (300000, `--locked`) | no      |
| `cargo-standard`                | `cargo_format`             | write    | `cargo`                      | `write` = `fmt` (300000)                                                | no      |
| `cmake-standard`                | `cmake_configure`          | build    | `cmake`                      | `default` -S . -B `.kmj-codebridge-build` (300000)                      | no      |
| `cmake-standard`                | `cmake_build`              | build    | `cmake`                      | `debug`, `release`, `--parallel 2` (300000)                             | no      |
| `cmake-standard`                | `cmake_test`               | build    | `ctest`                      | `debug`, `release`, `--parallel 2` (300000)                             | no      |
| `windows-visual-qa`             | `windows_visual_qa`        | build    | `node`                       | `capture`, `compare`, `accessibility` (120000)                          | no      |
| `windows-python-trial-qa`       | `windows_python_trial_qa`  | build    | `node`                       | `doctor` (30000), `tests` (300000), `smoke` (120000)                    | no      |
| `calibration-v4-software-qa`    | `calibration_v4_qa`        | build    | `python` (win32) / `python3` | `full` = `tools/verify.py` (300000)                                     | **yes** |
| `calibration-studio-qt-offline` | `calibration_studio_qt_qa` | build    | `python` (win32) / `python3` | `full` = `tools/codebridge_locked_release_qa.py` (300000)               | **yes** |
| `vioso-clone-rig-readonly`      | `vioso_rig_preflight`      | build    | `python` (win32) / `python3` | `displays` (30000)                                                      | **yes** |
| `go-standard`                   | `go_verify`                | build    | `go`                         | `test`, `vet`, `build` (300000)                                         | no      |
| `go-standard`                   | `go_format`                | write    | `gofmt`                      | `write` = `-w .` (300000)                                               | no      |

Fixed built-in commands (not config-driven, fixed variants): `browser_public_qa`
(`start`), `main_platform_ui_deps` (`ci`), `main_platform_php_deps`
(`ci`, `routes`, `test`), `main_platform_offsite_status` and
`cloudos_host_storage_audit` (`overview`, inspect), `cloudos_release_qa` (`full`),
`cloudos_origin_https_audit` (`check`, inspect, **kmj-elite-cloudos only**).

The last profile runs a fixed inline Python script, not an arbitrary repository
script. It requires the writable authorized `kmj-cloudos` project on the exact
CodeBridge device `kmj-elite-cloudos`, then rechecks the on-host name
`KMJ-elite`. It contacts only `127.0.0.1:8080` and `127.0.0.1:443` to request
`/info` with the fixed SNI/Host `cloudos.kmjtechno.com`, validates system-CA
TLS and an exact CloudOS HTML marker, and prints bounded status only. It
never enables a service, downloads certificates, edits Nginx, reads private
keys, changes DNS, or grants public HTTPS/commercial-release credit. The
30-second job is still **not** proof of real public reachability; source
installation, host-profile availability and an external HTTPS acceptance check
must all be independently observed before any release decision.

## 5. Gaps against the M1 target (Pending)

- CMake/CTest profiles exist (`cmake-standard`) but have **no** receipt from the
  authorized Windows P720 or the CineCore project. Status: pending.
- No explicit output-size/log-byte cap or memory/CPU limit is documented here for
  the generic runner; only `timeoutMs` and `--parallel 2` are enforced by profile.
  Verify against `src/jobs.js` before claiming bounds.
- KMJ Calibration Studio has a new **owner-opt-in**, detached-head offline Qt
  verifier profile. It is not enabled on the P520 until the administrator
  explicitly configures the protected project; its source depends on the
  accompanying `tools/codebridge_locked_release_qa.py` in the Studio repo.
  Windows exact-head execution, native visual parity and hardware calibration
  remain unverified. Other Qt projects still use generic CMake. Commands
  whose gate starts with `command:cmake_` additionally inherit `CMAKE_PREFIX_PATH`
  on Windows (at most 16 absolute directories, no control characters, no `..`
  segments, at most 4096 characters); no other job inherits it.
- Windows MAX_PATH: a CMake project configured inside an isolated lane under the
  agent state folder can exceed the Visual Studio generator's path limit
  (FileTracker error FTK1011 seen on the P520). Mitigation available: the owner
  may set the optional agent.json `laneBaseDir` to a short absolute directory
  (for example `C:\\kcb`, at most 120 characters, disjoint from every project
  root) and lanes are then created there instead of under `stateDir`. It is
  never taken from tool input. Status: mitigation implemented and unit tested
  on Linux only; not yet proven on the P520.
- Lane dirtiness: the fixed generated `.kmj-codebridge-build` directory of the
  `cmake-standard` profile no longer counts as unsaved work, so one lane can run
  `cmake_configure`, `cmake_build` and `cmake_test` in sequence. Every other
  untracked or modified path still makes the lane dirty, and cleanup removes the
  generated directory (never through a link) before `git worktree remove`.
- Any GUI/HIL interaction needs explicit user consent and stays pending.

## 6. What is not claimed

This document proves no build or test ran on any device. It is a contract
description checked against source and a drift test, nothing more.


## KMJ Calibration Studio P520 owner-only opt-in (2026-11-12)

`calibration-studio-qt-offline` is disabled by default. A new **local-only**
PowerShell 5.1 tool, `scripts/windows/ENABLE-CALIBRATION-STUDIO-QA.ps1`,
accepts `-SelfTest` (no user files), default read-only preflight, or explicit
`-Apply`. It is not callable as an unrestricted MCP shell.

Prerequisite: the P520 CodeBridge checkout must fast-forward to a commit
containing the merged source preset (`91718429`), be tracked and clean,
and point at the canonical `kmjtechno/kmj-codebridge` origin. The protected
owner-browser-paired device must match the current Windows hostname,
contain exactly the approved `kmj-calibration-studio` Git project,
and reference the canonical `kmjtechno/KMJ-Calibration-Studio` origin.

Without `-Apply` the script validates the source and private scope, reports
`READY_FOR_OWNER_APPLY` and changes no files. With `-Apply`, it adds only
`calibration-studio-qt-offline` to that project's `commandPresets`,
preserves other fields/presets and private credentials, validates the staged
JSON against the actual CodeBridge Zod agent schema and uses an atomic
same-directory replacement with a private ACL and protected original backup.
Any wrong host, symlink, dirty source, untrusted origin, unknown schema,
failed ACL or duplicate project identity fails closed.

**Important:** even after an applied config write the running CodeBridge
agent is **not** restarted. It will keep the old in-memory profile until
an operator-approved, scoped restart. Verify remote `list_project_commands`
then the exact isolated HEAD before running the Qt acceptance command.
No physical projector activation, camera scan, cloud deployment or user
password/token export occurs in this opt-in.
