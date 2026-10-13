# KMJ CodeBridge — Zero-Cost Autonomous Engineering Plan

Status: phased proposal; only the pure routing admission policy and unit tests are
included in the initial PR. This is **not** a live cloud model connector, a
cross-platform installer, a dashboard, or an unattended coding agent.

## Invariants

1. No unexpected paid API calls. Cloud use requires explicit approval, and
   only owner-verified free-tier model descriptors are allowed. Configure a
   server-side financial hard stop where a provider offers one.
2. Private source never goes to a cloud model unless that destination is
   specifically authorized for private code. Keep keys in an encrypted,
   access-controlled server-side vault, never in source, localStorage, MCP
   tool output, PR comments, or worker logs.
3. LLM-generated changes are untrusted. Run only preapproved project commands
   in isolated worktrees; verify with exact-head checks before merging.
4. No rate-limit evasion by rotating accounts, multiple keys, or identities.
   Follow GitHub's Terms, webhooks, conditional caching, retries and
   Retry-After. Prefer GitHub App installation tokens and least privileges.
5. No claims of 24/7 guaranteed throughput: local power, networking,
   hardware, provider quotas, user-granted permissions and approval gates
   can stop progress. Resume safely after failures instead of looping.
6. Do not silently summarize away, truncate, or omit task history on model
   changes. Use durable, versioned task context and Git checkpoint references;
   if the next model cannot hold the context, pause or use an explicitly
   validated context-compaction operation.
7. No new infrastructure, external service or mandatory runtime dependency
   without benchmarked need. Reuse Node, Git, CodeBridge, Ollama and existing
   GitHub App authorization.

## Implemented in initial PR

- Model admission by capability, context window, explicit cloud permission,
  private-code allowance, free flag and strict local-first priority.
- Conservative rejection of paid or nonapproved destinations.
- Header-driven remaining-requests and remaining-tokens tracking where a
  provider exposes it; proactive admission rejection if a bounded request
  would exceed the reported remaining amount.
- HTTP 429 Retry-After and 401/403 cooldown, plus compatible relative
  quota-reset windows; metadata-only restart snapshot (no API credentials).
- Unit tests using built-in Node test runner. No package added.

**Limits of this slice:** It does not make HTTP inference calls, integrate a
credential vault, persist state to disk, install services, manage real free
credits, or expose dashboard controls. The host must authenticate observed
provider responses; models marked free must first be verified by an
administrator. Unknown balances are unknown, not zero or unlimited. Providers
that expose no reset may require a rate-limited credential/health probe.

## Next engineering slices (sequence)

### P0: Provider-safe execution

- Owner-approved provider registry for OpenAI-compatible chat endpoints and
  optional native adapters (Anthropic/Gemini) where APIs differ.
- Server-side encrypted secret storage; owner-only add/test/rotate/revoke.
  Do not expose API keys in requests made from dashboard JavaScript.
- HTTPS endpoints from an admin-controlled allowlist; prevent redirects to
  untrusted hosts, SSRF, metadata IPs, local network targets and DNS rebinding.
- Explicit policy for free-only models, spending hard stops, input/output
  token estimates, concurrent quota reservations and provider-verified quota.
- Persist bounded quota state atomically. Show verified/estimated/unknown
  remaining credits separately and display last verified timestamp.
- Meter real calls against project-scoped approvals and maintain tenant
  boundaries; never fall back to paid services silently.

### P0: Resume-from-roadmap engineering

- Parse README/roadmap as untrusted instructions into a reviewable task DAG.
- Associate task acceptance criteria, prerequisites, source references, file
  locks, context hashes and an allowed project root with every task.
- Reuse CodeBridge's Autopilot journal and leases; implement bounded
  retry/timeout, failing-task isolation, health checks and durable handoff.
- Human review remains mandatory for privilege escalations, billing,
  credential changes, destructive operations and unsafe deployments.
- Run tasks in isolated Git worktrees using approved gates, exact SHA
  assertions and protected merge workflows.

### P1: Native one-click installers

- Windows: signed MSI/MSIX, service watchdog, startup after reboot.
- macOS: notarized signed pkg/app + launchd, Intel/Apple Silicon matrix.
- Linux: verified deb/rpm/AppImage where appropriate + systemd user/system
  service and rollback.
- Pinned signed manifests with offline verification, clean uninstall, scoped
  enrollment and secret-safe diagnostics. Never pipe arbitrary latest remote
  scripts to privileged shell.
- One-click requires OS trust prompts, device authorization and first-time
  GitHub App/provider consent; these cannot be bypassed.

### P1: GitHub-native integration

- GitHub App with least permissions, short-lived installation credentials,
  webhook signature verification, replay protection and repository allowlist.
- Webhook-driven issue/PR/check sync, conditional ETag GET, bounded
  mutations, installation-rate aware queue and standards-compliant backoff.
- GitHub Actions only within free quotas; self-hosted execution only inside
  isolated trusted environments, never on the production VPS.
- Per-repository metrics: queue time, accepted fix rate, CI cost/time,
  failed tests, merge conflicts and release rollback.

### P2: Dashboard

- Device/project enrollment, GitHub connection health, task queue,
  usage/cost guardrails, provider adapters and quota provenance,
  model fallback audit, reproducible benchmark baselines, rollback controls.
- First ship functional backend APIs and permission tests; do not publish
  decorative controls or claim unsupported features.

## Relevant upstream references

- OpenCode: https://github.com/anomalyco/opencode
- Aider: https://github.com/Aider-AI/aider
- OpenHands SDK: https://github.com/OpenHands/software-agent-sdk
- llama.cpp: https://github.com/ggml-org/llama.cpp
- LiteLLM: https://github.com/BerriAI/litellm
- GitHub API best practices:
  https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- GitHub Actions security:
  https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions

These are architecture references, not automatically approved new dependencies.
