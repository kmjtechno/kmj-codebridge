# KMJ CodeBridge + Desktop Commander convergence

Status: active product direction

KMJ CodeBridge is the primary secure AI-to-device/project control plane. The strongest KMJ Desktop Commander capabilities should converge into CodeBridge instead of creating parallel, incompatible execution paths.

## Product rule

CodeBridge keeps its existing device enrollment, tenant/project grants, MCP authorization, bounded project roots, structured command profiles, supervisor boundary, persistent jobs, autopilot DAG, release verification, and licensing architecture.

Desktop Commander contributes proven control-plane ideas where they improve device operations, diagnostics, policy, recovery, auditability, and operator UX.

No convergence feature may add an unrestricted AI shell, caller-controlled root path, raw sudo channel, browser-visible secret, or arbitrary systemd/service target.

## Capability convergence matrix

| Desktop Commander capability             | CodeBridge target                                                                            | Status                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------- |
| Remote probe / host diagnostics          | Supervisor-backed bounded device resource status                                             | Native                      |
| Recursive file explorer                  | Bounded project_tree with denylisted paths and symlink rejection                            | Implementing                |
| File metadata                            | Project_file_info returns approved file size and modification time                          | Implementing                |
| Process / session listing                | List persisted CodeBridge project jobs, no machine-global process enumeration               | Implementing                |
| File read and multi-read                 | Scoped read_file, read_file_range and read_files_batch with redaction                       | Native                      |
| File write and edit                      | Hashed preconditions, preview and atomic multi-file updates                                 | Native                      |
| Full-text search                         | Bounded project search_code and repository map                                               | Native                      |
| File move / rename                       | Controlled within-root operation with hash guards and audit                                 | Next                        |
| Create directory                         | Controlled within-root operation with policy and audit                                      | Next                        |
| Arbitrary process listing or kill        | Restricted to CodeBridge-managed jobs only                                                  | Restricted                  |
| Project inspect / stack discovery        | Structured project environment detection                                                     | Native                      |
| Persistent operation jobs                | Existing CodeBridge JobRunner + bounded logs/cancel                                          | Native                      |
| AI-safe structured operations            | Existing gates + command profiles + supervisor requests                                      | Native                      |
| Deny-by-default execution boundary       | Existing MCP authorization + project roots + supervisor allowlists                           | Native                      |
| Replay/idempotency protection            | Existing request keys / job fingerprints / grant validation                                  | Native; expand where needed |
| Persistent task queue                    | Existing AutopilotJournal + missions/DAG                                                     | Native                      |
| Reconnect/crash recovery                 | Agent lock, persistent journals, service supervisor, gateway heartbeat/reconnect telemetry   | Native                      |
| Risk classes                             | READ / TEST / EDIT / GIT_WRITE / SERVICE / DEPLOY / PRIVILEGED / DESTRUCTIVE policy metadata | Native                      |
| Approval gate                            | Main Platform approval records for privileged/destructive actions                            | Next                        |
| Hash-chained audit evidence              | Append-only per-device/project evidence ledger                                               | Native                      |
| Resource-aware scheduler                 | CPU/RAM/disk/load-aware concurrency and backpressure                                         | Native                      |
| Smart test selection                     | Stack-aware targeted verification before full release gates                                  | Implementing                |
| Checkpoint / rollback                    | Project snapshots and rollback evidence before risky mutations                               | Planned                     |
| Controlled privileged broker             | Narrow supervisor operations with explicit policy + approval                                 | Planned                     |
| Desktop notifications / mobile approvals | Main Platform + optional native companion UX                                                 | Planned                     |
| Native Tauri desktop shell               | Optional CodeBridge operator client, not a second backend                                    | Planned                     |
| SSH saved profiles                       | Replaced by CodeBridge device enrollment; secrets stay outside browser/MCP                   | Replaced                    |
| Raw remote shell                         | Not adopted                                                                                  | Rejected                    |

## Commander Diagnostics slice

The first convergence slice adds:

- `supervisor_device_status`: bounded CPU count, memory, load, uptime, platform, architecture, hostname, and Node runtime identity from the already-enrolled device.
- `project_environment`: deterministic stack/framework/package-manager detection from approved project metadata without executing project code.
- Fast-read compatibility so both signals can be composed with existing CodeBridge read workflows.

These tools are read-only and inherit the same device/project authorization as every other CodeBridge MCP operation.

## Security invariants

1. Unknown operations fail closed.
2. Device diagnostics accept no command, path, process ID, environment variable, or service name from the caller.
3. Project environment detection operates only inside the already-authorized project root.
4. Project detection never runs package scripts, build hooks, interpreters, or repository code.
5. Supervisor operations remain fixed and allowlisted.
6. Privileged and destructive capabilities require dedicated policy and approval; they are never smuggled through a generic command interface.
7. Credentials, SSH keys, tokens, environment secrets, and arbitrary process environments are not returned.
8. Existing CodeBridge tenant/device/project authorization remains authoritative.
9. All future write/execute convergence features require idempotency, bounded output, audit evidence, and regression tests.

## Next implementation order

P0:

- device resource/capability snapshot;
- project stack/environment auto-detection;
- expose both through read-only MCP;
- retain cross-platform CI and credential scan gates.

P1:

- formal risk-class metadata and policy decision tool;
- append-only hash-chained audit/evidence ledger;
- resource-aware job concurrency and disk-pressure guard;
- heartbeat/watchdog/reconnect status surfaced to Main Platform.

P2:

- smart test selection with conservative full-gate escalation (current slice);
- checkpoint/rollback primitives;
- controlled privileged broker with Main Platform approvals;
- mobile approval workflow;
- optional native CodeBridge operator client using the same backend and policy engine.

## Commander File and Session Explorer slice

Three new read-only tools are available from the **same** CodeBridge MCP
connection; no separate Desktop Commander backend is created:

- `project_tree` — browse at most 200 directory/file entries, to a maximum
  recursive depth of five, using the existing project-root and sensitive-file
  filtering. Does not follow symlinks or expose arbitrary host files.
- `project_file_info` — return a permitted file's size and modification
  timestamp, without reading or transmitting its contents.
- `list_project_jobs` — read up to 100 recent persistent CodeBridge
  execution sessions in the caller's authorized project. No stdout/stderr,
  shell environment, token, command arguments, or other project sessions
  appear in the summary.

Remaining Desktop Commander capabilities require explicit designs rather than
unrestricted privilege passthrough: cross-platform safe path creation/moves,
bounded process control through approved profiles, optional native UI, and
Main Platform-backed approvals for privileged/destructive operations.

## Product-wide feature status

The user-facing goal is **Desktop Commander-class usability within one
CodeBridge app**, not copying its unrestricted host powers. Existing features
cover project listing, safe read/write/edit, search, Git operations, approved
jobs, logs, diagnostics, connection status, and audit. Full parity remains
unfinished until the remaining features are verified and deployed.

## Success criteria

- One KMJ control plane for ChatGPT/Claude/IDE/device/project operations.
- No second unrestricted remote-execution backend.
- Normal diagnostics and project discovery require no terminal commands.
- Safe work remains autonomous and fast.
- Higher-risk operations gain stronger policy, approval, and evidence instead of broader shell access.
