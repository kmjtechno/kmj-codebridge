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
| Smart test selection                     | Stack-aware targeted verification before full release gates                                  | Planned                     |
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
- heartbeat/watchdog/reconnect status surfaced to Main Platform (current slice).

P2:

- checkpoint/rollback primitives;
- controlled privileged broker with Main Platform approvals;
- mobile approval workflow;
- optional native CodeBridge operator client using the same backend and policy engine.

## Success criteria

- One KMJ control plane for ChatGPT/Claude/IDE/device/project operations.
- No second unrestricted remote-execution backend.
- Normal diagnostics and project discovery require no terminal commands.
- Safe work remains autonomous and fast.
- Higher-risk operations gain stronger policy, approval, and evidence instead of broader shell access.
