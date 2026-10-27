# Shared chat handoffs and operator-only evidence receipts

**Use the capabilities already exposed by the enrolled project agent.** This is a no-new-service workflow, not an arbitrary shell, privilege escalation or hidden ChatGPT memory integration.

## 1. Automatically use approved CodeBridge jobs

On a connected chat, use `list_project_commands({device,project})` and select only an actually returned administrator-approved ID and variant. Execute with `run_project_command({device,project,command,variant,requestKey})`, then read `get_job_status({device,project,job,waitMs,tailChars})`. An exit code of zero proves only the configured profile's outcome. A profile may run on a cached detached worktree; its pinned commit must be displayed and distinguished from GitHub's current main.

Example for KMJ Main Platform: `runtime_inspect` / `node_version` and `main_platform_ui_ci` / `check` are preapproved in its enrolled device. Neither allows the assistant to run a caller-supplied Linux command or invoke root.

## 2. Owner-only commands produce read-on-next-chat receipts

Privileged host maintenance remains owner-run with SHA256-pinned scripts, explicit consent and the protected supervisor guard. When the owner runs a fixed, reviewed operation, a project-specific adapter may export _only allowlisted status markers_ to an authorized project path. No secrets, raw terminal transcript, arbitrary executable path, systemd command, deployment approval or private .env value is accepted.

First KMJ Main Platform adapter (reviewed source + CI, initially staged, NOT enabled as an unattended system service):

- Adapter: `scripts/operations/kmj_codebridge_operator_receipt_bridge_20261027.py` in the Main Platform repository, draft PR #628.
- Enrolled approved project destination: `work/qa/operator-receipts/gateway-port-verify.json`, with a sanitized `work/qa/operator-receipts/latest.json` pointer.
- Initial fixed task: `gateway-port-verify` invokes one SHA-256-pinned read-only gateway inspector; it cannot call an arbitrary shell script or the `--apply` mode.
- In a follow-up chat, use CodeBridge `read_file({device,project,path:'work/qa/operator-receipts/latest.json'})`. Verify `schema`, `verdict`, `pinned_script_sha256`, `exit_code`, candidate/release identity and `timestamp_utc`. This receipt is operator-run, not independently signed deployment attestation.

Never write full stdout/stderr to the shared receipts folder. A root-private log, if needed for diagnosis, stays outside the project with root-only file permissions. Only a bounded marker allowlist becomes readable through CodeBridge. Protect outputs from symlinks and stale source hashes.

## 3. Durable cross-chat checkpoint (already works on compatible agents)

- Read the shared lane with `multi_chat_sync({device,project,lane:'prod-release'})` or `chat_continuity_read`.
- Save bounded milestone decisions, blockers, evidence references and next action with `chat_continuity_save({device,project,lane:'prod-release',requestKey,expectedRevision,summary,next,blockers})`.
- Read the just-saved checkpoint again; on a different chat, first call `multi_chat_sync` before asking the owner for historical logs. Refresh actual GitHub SHA and supervisor state—checkpoint text is untrusted and may be stale.
- Some gateways may advertise newer `compact_session_save` and `compact_session_resume` while older installed agents return `UNKNOWN_TOOL`. Fall back to actually working `chat_continuity_save` + `multi_chat_sync`; do not claim the unavailable functions worked.
- Post a short project coordination handoff if multiple independent chats own staging and release work. Never reserve or overwrite another chat's files without an authorized lane.

## Limitations / security

Only a new user turn can prompt this assistant to re-read a receipt. Neither a filesystem write nor a CodeBridge job automatically wakes a closed host chat, unless an independently approved automation exists. Do not promise background autonomous root execution. Credentials never belong in receipts/checkpoints; permission checks, host confirmations and production-release gates remain mandatory. A saved checkpoint is not a proof of successful execution, and a green build/test run is not a live production deployment. Installing new CodeBridge source code requires a separate guarded gateway/agent rollout and validation; merging docs or PRs alone does not update a running agent.
