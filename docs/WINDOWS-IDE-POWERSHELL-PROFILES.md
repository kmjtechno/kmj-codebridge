# Local Windows IDE/CLI automation with approved PowerShell tasks

CodeBridge can perform local development work on an enrolled Windows PC through the same scoped MCP tools used by IDE and chat clients: inspect files, make guarded edits, check Git, run approved tests, inspect a job receipt, diagnose, and repeat. It **does not** expose an unrestricted PowerShell terminal or an administrator shell.

This feature makes native PowerShell usable when an IDE project actually needs it, without requiring the owner to paste the same commands into PowerShell over and over.

## Security and initial administrator opt-in

A trusted administrator installs a Windows CodeBridge agent under a **least-privilege current-user account**, authorizes only the intended project, and reviews a project-local, versioned `.ps1` script. Then the administrator opts into a structured project command profile in the private agent configuration. One possible structure:

```json
{
  "id": "my-project",
  "root": "D:\\Projects\\my-project",
  "writable": true,
  "gates": {},
  "commandPresets": [],
  "commands": {
    "windows_qa": {
      "category": "build",
      "description": "Approved Windows project verification",
      "command": "powershell.exe",
      "variants": {
        "verify": {
          "args": [],
          "timeoutMs": 120000,
          "powershellScript": {
            "path": "scripts/qa/windows-verify.ps1",
            "sha256": "REPLACE_WITH_THE_ACTUAL_64_HEX_SHA256_OF_REVIEWED_COMMITTED_SCRIPT"
          }
        }
      }
    }
  }
}
```

The example digest is a placeholder, not a valid authorization. The actual script and SHA-256 must be reviewed and set **locally** by the account administrator. This is a one-time project-onboarding task, not something the AI client can perform silently. Script changes require a new review/digest. Never put credentials, private enrollment or secrets inside scripts or command arguments.

Only `build` and `write` profiles can use `powershellScript`; never classify an executing script as read-only `inspect`. The agent refuses untrusted executables, malformed/absolute/traversing/UNC paths, symlinks, hard-linked scripts, empty or oversized (>64 KiB) scripts, and mismatched SHA-256. `scripts/a.ps1` is an example of the required **project-relative slash-delimited** path. It must be present in Git at the exact HEAD; a script available only as an uncommitted local file cannot be auto-run.

## Single CodeBridge action, not repeated manual commands

After a verified device grant and first-time administrator configuration, any authorized MCP client can call:

```text
list_project_commands(device, project)
run_project_command(
  device=<approved device>,
  project=<approved project>,
  command="windows_qa",
  variant="verify",
  requestKey=<unique stable identifier for this invocation>
)
get_job_status(device, project, job=<returned id>, waitMs=10000)
```

PowerShell is launched through Windows' own `System32/WindowsPowerShell/v1.0/powershell.exe` with `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File <approved script>` and only the administrator-fixed argument array. The chat client does **not** submit a command string, executable, environment, working directory, `-EncodedCommand`, path, or arbitrary arguments. Runtime uses `spawn(shell=false)`, a sanitized environment, bounded timeouts and output, cancellable jobs and durable, redacted receipts. A fixed PowerShell script itself executes project code and has the privileges of the local CodeBridge user: **file containment of command side effects is not an OS sandbox**. Only install vetted project scripts and do not run an agent as local Administrator.

When `laneId`/`expectedHead` are absent, CodeBridge automatically prepares a clean detached Git worktree at the **actual local current HEAD**. This protects the user's separate dirty checkout, does not reset or clean tracked/untracked changes, and gives the job an exact SHA receipt. A script hash/path and lane HEAD are checked before queuing **and again immediately before starting**. Reusing a pinned lane after its source changed fails closed. Existing four-lane quota applies; extra worktrees are not deleted automatically.

This is **not** remote interactive PowerShell, GUI desktop takeover, shell session persistence, arbitrary installations, production deployment, or device/service management. Native GUI applications may fail in Session 0 even if a headless test succeeds; physical interaction requires an operator-owned interactive session. A disconnected PC requires local agent recovery first.

## Release requirements

The Windows CI functional regression actually executes a committed `.ps1` in an isolated worktree and preserves a separate untracked owner file. Ubuntu tests check schema validation, path/digest rejection, and security invariants. CI cannot prove a customer's PC enrollment, their Qt/MSVC installation, model entitlements, optical calibration, safety gates, or full IDE compatibility.

For QA receipts, distinguish: source CI PASS, enrolled local agent READY, real Windows test PASS, GUI/hardware evidence PASS, and independent release approval. Do not infer one from another.
