# Codex-style local development terminal: staged backend

Goal: ChatGPT/Claude clients can use the existing CodeBridge project-scoped
read, edit, Git, worktree, job and CI capabilities together with a genuinely
isolated command execution backend.

This source step adds an internal, explicit-opt-in terminal core. Its trusted
adapter accepts a locally installed, exact image ID, not a mutable tag.
Container creation uses fixed non-root, no-network, no-host-mount,
read-only-root, dropped-capability, CPU, memory and PID limits. A command is
passed only to the container shell. Start is bounded and the exact created
container ID must be cleaned up before returning an execution receipt.

The tests exercise the contract with a fake Docker adapter. They do **not**
prove local Docker Desktop, a real daemon, a sandbox escape test, or a
working ChatGPT terminal. No MCP route, host executable resolution, agent
config change, automatic image pull, source export, writable host mount or
production deployment is included. The next step is a trusted local adapter
with a pinned local daemon and sanitized process environment, restart/orphan
reconciliation, then an explicit project snapshot/export-import workflow
with exact SHA and file guards. Integrate bounded redacted output and
cancellation into the existing job runner before exposing an MCP command.
Real P520 acceptance and signed runtime deployment remain mandatory.

Windows-native IDE tasks continue through the separate owner-approved
command profile mechanism. Full host Administrator/PowerShell access is
not a substitute for a sandbox. The host ChatGPT client controls its
available tools and UI; a connector cannot grant itself Codex's internal
permissions or change the host product.

## Pinned local Docker adapter candidate

The internal adapter admits only the fixed core argv and process limits,
requires explicit opt-in, verifies the canonical Docker executable SHA-256,
uses a fixed local Linux socket or Windows Docker Desktop Linux pipe, and
runs without inherited Docker/proxy/credential settings. It only starts or
removes container IDs created by that adapter instance. The installation
path and local daemon must be protected by the operator; hashing alone is
not a filesystem lock or daemon identity attestation. Output is withheld
except for container creation identity. A process timeout or failed create
may leave an orphan, so restart-safe reconciliation, workspace transfer,
cancellation, streaming redaction, MCP routing and real P520 tests remain
required. This source candidate does not activate Docker or alter a device.

The internal core also accepts an optional trusted AbortSignal. Cancellation
before create prevents execution, cancellation during create skips start
after a verified ID arrives, and cancellation during start interrupts the
CLI. Exact-ID cleanup is never passed that signal; cleanup failure takes
precedence over a cancellation receipt. This does not cancel an ambiguous
create or prove that a remote job has stopped. Agent restart recovery and
public MCP job cancellation are not yet connected.
