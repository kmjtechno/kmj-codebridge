# Command-profile schema and compatibility matrix

Document version: **1.0** (2026-11-08). Milestone: **M0 inventory/contracts** of
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
   `calibration_v4_qa`, `vioso_rig_preflight`) run only in a SHA-pinned isolated
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

| Preset                       | Profile id                | Category | Executable                   | Variants (timeout)                                                      | Lane    |
| ---------------------------- | ------------------------- | -------- | ---------------------------- | ----------------------------------------------------------------------- | ------- |
| `node-standard`              | `node_deps`               | network  | `npm`                        | `locked` = `ci` (300000)                                                | no      |
| `node-standard`              | `node_verify`             | build    | `npm`                        | `test`, `build`, `check`, `lint`, `typecheck` (300000)                  | no      |
| `node-standard`              | `node_format`             | write    | `npm`                        | `write` = `run format` (300000)                                         | no      |
| `node-standard`              | `node_dev`                | build    | `npm`                        | `start` = `run dev` (300000)                                            | no      |
| `main-platform-ui-ci`        | `main_platform_ui_ci`     | build    | `npm`                        | `check`, `types`, `build` under `--prefix apps/platform` (300000)       | **yes** |
| `python-standard`            | `python_deps`             | network  | `python3`                    | `requirements` (300000)                                                 | no      |
| `python-standard`            | `python_verify`           | build    | `python3`                    | `test` (pytest), `compile` (300000)                                     | no      |
| `cargo-standard`             | `cargo_verify`            | build    | `cargo`                      | `check`, `build`, `test`, `clippy`, `format_check` (300000, `--locked`) | no      |
| `cargo-standard`             | `cargo_format`            | write    | `cargo`                      | `write` = `fmt` (300000)                                                | no      |
| `cmake-standard`             | `cmake_configure`         | build    | `cmake`                      | `default` -S . -B `.kmj-codebridge-build` (300000)                      | no      |
| `cmake-standard`             | `cmake_build`             | build    | `cmake`                      | `debug`, `release`, `--parallel 2` (300000)                             | no      |
| `cmake-standard`             | `cmake_test`              | build    | `ctest`                      | `debug`, `release`, `--parallel 2` (300000)                             | no      |
| `windows-visual-qa`          | `windows_visual_qa`       | build    | `node`                       | `capture`, `compare`, `accessibility` (120000)                          | no      |
| `windows-python-trial-qa`    | `windows_python_trial_qa` | build    | `node`                       | `doctor` (30000), `tests` (300000), `smoke` (120000)                    | no      |
| `calibration-v4-software-qa` | `calibration_v4_qa`       | build    | `python` (win32) / `python3` | `full` = `tools/verify.py` (300000)                                     | **yes** |
| `vioso-clone-rig-readonly`   | `vioso_rig_preflight`     | build    | `python` (win32) / `python3` | `displays` (30000)                                                      | **yes** |
| `go-standard`                | `go_verify`               | build    | `go`                         | `test`, `vet`, `build` (300000)                                         | no      |
| `go-standard`                | `go_format`               | write    | `gofmt`                      | `write` = `-w .` (300000)                                               | no      |

Fixed built-in commands (not config-driven, fixed variants): `browser_public_qa`
(`start`), `main_platform_ui_deps` (`ci`), `main_platform_php_deps`
(`ci`, `routes`, `test`), `main_platform_offsite_status` and
`cloudos_host_storage_audit` (`overview`, inspect), `cloudos_release_qa` (`full`).

## 5. Gaps against the M1 target (Pending)

- CMake/CTest profiles exist (`cmake-standard`) but have **no** receipt from the
  authorized Windows P720 or the CineCore project. Status: pending.
- No explicit output-size/log-byte cap or memory/CPU limit is documented here for
  the generic runner; only `timeoutMs` and `--parallel 2` are enforced by profile.
  Verify against `src/jobs.js` before claiming bounds.
- Qt-specific profiles do not exist; Qt builds go through CMake only.
- Any GUI/HIL interaction needs explicit user consent and stays pending.

## 6. What is not claimed

This document proves no build or test ran on any device. It is a contract
description checked against source and a drift test, nothing more.
