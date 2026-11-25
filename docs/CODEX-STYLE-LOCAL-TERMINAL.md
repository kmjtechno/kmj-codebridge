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
