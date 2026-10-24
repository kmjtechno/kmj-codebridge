# KMJ CodeBridge: IDE-style single-call QA (Home Office Calibration Pro)

**Goal:** no repeated PowerShell command pasting or 200-line QA logs. A connected, explicitly authorized Home Office CodeBridge agent can execute project-owned, administrator-approved tools on an isolated exact-head worktree, and ChatGPT can read a concise result directly.

## Current blocker (verified 2026-10-24)

For `kmj-homeoffice-desktop-5fvjmet / kmj-calibration-pro`, the account grant exists, but the gateway reports `GATEWAY_REGISTRATION_MISSING`. **No new server-side tool can run on that PC before actual device pairing/registration and an online agent.** P720 is a different device, and cloud/production agents must not be substituted for physical Home Office QA.

From a **trusted, clean, fully installed** CodeBridge checkout on `DESKTOP-5FVJMET`, the owner may double-click `scripts/windows/ONE-CLICK-CALIBRATION-IDE.cmd`. It calls the existing `ONE-CLICK-AGENT-AUTOCONNECT.ps1 -Device HomeOffice` first, then the existing **read-only** device doctor; if first-time pairing is needed, the owner approves it in the browser. It cannot silently approve device grants, bypass the production gateway release gate, install dependencies, change DNS, create credentials when forbidden, or touch projectors. A click alone is **not** account-side READY; verify `connection_overview` before claiming success.

## New MCP tools after connected agent runtime is deployed

`ide_run_project_task` (execute+read permission):
- Inputs: `device`, `project`, approved `command` profile, exact named `variant`, stable `requestKey`, optional detached `laneId`, optional `expectedHead` and bounded `waitMs`.
- Uses the **same** policy-enforced `run_project_command` backend (including SHA-pinned isolated-lane handling for `calibration_v4_qa`), immediately reads job state using the existing `get_job_status` mechanism and returns a compact receipt.
- **Never accepts** raw PowerShell, CMD, bash, arbitrary executables, argv, environment, cwd or timeouts from an AI client. An owner can add a separately approved and SHA-256-pinned local PowerShell build profile under the existing reviewed security model; this is not unrestricted terminal access.
- Existing `calibration_v4_qa:full` invokes a project-owned `tools/verify.py` in an isolated worktree: Debug+Release software verification, no projector/camera patterns or production promotion.

`ide_job_receipt` (read permission): retrieves one authorized project job's bounded status, so users no longer copy/paste terminal output. Retry idempotently using `requestKey` and follow a job by its opaque `job` ID.

Receipts include local job ID, state, exit code, `executionSucceeded`, up to 16 simple allowlisted QA markers and a SHA-256 checksum of the bounded log tail. They *never* echo raw log text or credentials; if deeper debugging is necessary, the already existing bounded/redacted `get_job_status` tool remains available. Printed markers are **untrusted claims by the test executable**, not proof that actual hardware, product safety or a release passed. `approvalOrDeploymentProven=false` always.

## Example intended conversation workflow

> Check the Home Office CodeBridge connection status. If READY, run the `calibration_v4_qa:full` approved profile via `ide_run_project_task`, then read `ide_job_receipt` for the resulting job. Show exact Git SHA, explicit PASS/FAIL, and only the most important failure if present. Do not enable projectors or deploy anything.

No copied PowerShell block. If the owner has not paired the agent, report `GATEWAY_REGISTRATION_MISSING` instead of making up a PASS or retrying against P720. The standalone Windows PowerShell scripts remain fallback paths for hardware-only tests that are **not** approved remote CodeBridge profiles.

## Security and release scope

- One writer per checkout, isolated lanes for approved profile execution, no Git reset/clean or mutation of original modified calibration sources.
- Deterministic local runner: resource/timeout limits, cancel, audit, redaction and idempotency from existing CodeBridge.
- No free-form remote terminal, privilege escalation, arbitrary file upload, unapproved scripts, self-hosted GitHub runner, third-party paid dependency or unsafe production cutover.
- Reverse-analysis of VIOSO 7 is reference material for *independent* product design only; do not copy vendor decompiled code, private keys or licensing mechanisms. Earlier findings suggest eight independently implementable wizard stages: topology, camera, ROI, pattern registration, solve, warp/blend, verification, save/export. Their actual completion and quality require separate KMJ engineering and physical QA.

## Installation and proof

The GitHub PR does not automatically update devices or the live MCP gateway. First review/test this change on Node 24+, merge after green source/unit CI, install/update **signed trusted** CodeBridge agent and plugin runtime using the existing guarded updater, then pair the Home Office PC (owner approval). Prove `connection_overview=READY` and run a small authorized test before claiming no-log-paste working end to end.
