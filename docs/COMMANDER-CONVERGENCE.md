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
| Recursive file explorer                  | Bounded project_tree with denylisted paths and symlink rejection                             | Native                      |
| One-click Workspace Home                 | One bounded MCP read for project environment, safe tree, gates and recent sessions           | Implementing                |
| File metadata                            | Project_file_info returns approved file size and modification time                           | Native                      |
| Process / session listing                | List persisted CodeBridge project jobs, no machine-global process enumeration                | Native                      |
| File read and multi-read                 | Scoped read_file, read_file_range and read_files_batch with redaction                        | Native                      |
| File write and edit                      | Hashed preconditions, preview and atomic multi-file updates                                  | Native                      |
| Full-text search                         | Bounded project search_code and repository map                                               | Native                      |
| File move / rename                       | Controlled within-root operation with hash guards and audit                                  | Native                      |
| File copy / duplication                  | Hash-verified bounded copy to a previously nonexistent authorized destination                | Implementing                |
| Create directory                         | Controlled within-root operation with policy and audit                                       | Native                      |
| Arbitrary process listing or kill        | Restricted to CodeBridge-managed jobs only                                                   | Restricted                  |
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
| Checkpoint / rollback                    | Private bounded file snapshots and read-only recovery planning; restore needs approval       | Implementing                |
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

## Commander File Copy slice

The `copy_project_file` operation uses the **same** CodeBridge connection,
tenant/project authorization, write entitlement and tamper-evident audit
ledger. Only a file within a customer-authorized writable root can be copied.
The source must match the supplied SHA-256. The destination must be absent,
will be created with private permissions and never overwrites an existing
file. Bounded binary files are supported; symlinks, hardlinks, secret paths,
unapproved folders and out-of-root paths fail closed. The source is kept
unchanged.

## Checkpoint safety baseline

The `checkpoint_create` tool stores one authorized UTF-8 file (maximum
64 KiB) inside the enrolled agent's restricted state directory. The caller
must provide the file's current SHA-256 and a stable request key. Replays are
idempotent; changed payloads with the same key fail closed. Known secret
bindings and protected paths cannot be captured. No checkpoint contents are
returned to an AI client.

`checkpoint_restore_plan` checks integrity, reads the currently authorized
file through project-root safeguards, and compares its SHA-256 with the
checkpoint. **It does not restore or modify files.** Actual rollback is
reserved for a separate approval-backed write operation after Main Platform
approval policy is implemented and tested. This avoids silently overwriting
newer customer work.

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
- resource-aware job concurrency, bounded queue/backpressure and disk-pressure guard;
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

## Guarded workspace operations

The second Commander convergence slice adds two write-scoped tools:

- `create_project_directory` creates one folder with mode `0700` inside an
  already-authorized writable project, requiring an existing safe parent.
- `move_project_file` copies up to 256 KiB inside the same approved project
  using exclusive destination creation, verifies SHA-256 before and after
  copying, and removes the original only after verification. It never
  overwrites an existing destination. Partial failures are audited.

Both operations reuse the existing CodeBridge write entitlement, device/project
grant, sensitive-path rejection and append-only audit attempt/result chain.
They do not accept absolute filesystem roots, shell commands, sudo flags, or
arbitrary host paths. This is bounded cross-platform file management, not
a general machine administrator interface.

## One-click workspace home

The `workspace_home` tool uses **one** project-scoped read-only request to
return approved folder structure, detected development stack, quality-gate
names, recent persisted jobs, and safe next action identifiers. It deliberately
excludes file contents, secrets, raw process environments, other projects and
arbitrary OS commands.

Both ChatGPT and Claude plugin guidance instructs a single device/project
selection automatically when that account has exactly one authorized target.
For accounts with multiple targets, it asks for the intended project rather
than guessing or mixing customer data.

## Resilient Job Manager (no Desktop Commander dependency)

CodeBridge's native `JobRunner` now self-wakes queued jobs after temporary
resource-probe failures or memory/disk pressure clears. It uses one bounded,
unref'd timer **only while queued work needs a resource recheck**; the timer is
cancelled when the queue drains or the agent shuts down. A busy licensed slot
still waits for the running job's completion rather than polling needlessly.
The runner does not automatically replay interrupted, failed or cancelled jobs.

The existing `list_project_jobs` tool includes project-scoped state counts,
queue positions (per authorized project), and elapsed job duration. The
existing `get_job_status` includes queue position and duration, while
`execution_capacity` reports journal occupancy, remaining record slots and
the bounded queue limit. No shell command, environment value, idempotency key,
other project's job details, or unredacted logs are exposed.

**Limits remain enforced:** free mode allows one concurrent job; signed
entitlements can authorize more, and resource pressure can reduce effective
concurrency. Journals still stop accepting new work at 1,000 records to avoid
unsafe silent pruning/replay; archival with retained idempotency tombstones is
future work. This is not permission for arbitrary terminal or privileged
machine administration.

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
