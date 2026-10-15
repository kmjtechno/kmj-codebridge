# KMJ CodeBridge sovereign engineering architecture

**Status: architecture decision and implementation gates, not a claim of release completion.**
Applies to CodeBridge self-hosted and managed deployments. Existing audited
modules should be composed, not replaced by unreviewed third-party agents.

## Invariants

1. No prompt, repository content, project secret or credential leaves a local
   device by default. Remote inference requires a tenant-approved provider,
   data classification, finite spending limit and current provider readiness.
2. A tenant, project or device ID supplied by a client never grants authority.
   Enforce signed identity, active entitlement, tenant/device/project grants,
   policy catalog, and capability/step-up checks at execution time.
3. Never treat an installed plugin, an available tool, an advisor's route plan,
   a successful draft or an MCP public catalog as real completed engineering.
   Real commits require isolated worktree status and exact-head test evidence.
4. Fail closed on unavailable providers, stale observations, uncertain rates,
   incomplete OAuth identity and ambiguous privilege. Never bypass API quota,
   rotate accounts to evade terms or silently charge for inference.
5. Audit attempt/result with a hash-chained append-only ledger and optional
   external signed anchors for independent tamper evidence. Hash chaining
   alone cannot prevent a privileged host operator from rewriting a whole log.

## Reuse the existing building blocks

| Function | Existing implementation | Next integration requirement |
| --- | --- | --- |
| Strict OAuth | `src/auth.js` | Complete client PKCE/DCR acceptance per client, with no wildcard bearer tokens |
| Isolated edits | `src/worktree-lanes.js`, `src/checkpoints.js` | Durable tenant-scoped lane lease and merge conflict handling |
| Autonomous DAG planning | `src/hyperspeed-plan.js`, `src/autopilot.js` | Real owner-approved worker lease -> gates -> review -> PR |
| Safe tools | `src/policy.js`, `src/command-presets.js` | Signed trust boundary and isolated process sandboxes |
| Free model policy | `src/model-failover-policy.js`, `src/smart-model-router.js` | Connect proven provider inventory, latency and quota observations to executor |
| Audit | `src/audit.js` | Retention, remote anchoring, integrity verification, incident export |
| Project status | `src/fleet-overview.js`, `src/project-progress.js` | Authenticated live telemetry, not hardcoded fleet statistics |

## Developer access without unsafe bypass

A local single-developer experience must have **the same authorization
boundaries**, but can remove unnecessary ceremony:

- Provide one-click creation of a local *loopback-bound*, short-lived,
  project-scoped developer session after an explicit OS-user approval.
  The session cannot be used from another machine; it has no automatic
  production/customer tenant privileges.
- PKCE S256, exact redirect URI registration and signed or introspected
  access tokens remain required for network-facing OAuth. Dynamic registration
  may recognize common CLI loopback ports with narrow validation but cannot
  accept arbitrary HTTPS origins, wildcard redirect patterns or open
  client impersonation.
- Local administrator settings must not disable tenant separation, audit
  events, executable tool policy, spending limits or signature validation.
  Production keys are not generated from predictable static seeds.
- Trusted self-hosted operators can use a local issuing authority with
  short-lived scoped tokens and user confirmation instead of relying on
  KMJ-hosted account services. Offline access must explicitly expire.

## Sovereign multi-provider inference

1. Query already-installed Ollama/self-hosted model capabilities on loopback
   first. When a tenant opts in to free cloud inference, require actual
   model support, provenance, no paid charge and tenant data-transfer approval.
2. Use existing `ModelFailoverPolicy` and provider quota provenance, not
   string-length heuristics or untrusted alternate endpoints.
3. Keep prompt/context provenance tied to the same task. Retry only when
   response semantics make it safe; require idempotency keys for side effects.
   Respect Retry-After and local cooldowns; never promise unlimited quota.
4. Emit structured route explanations: selected model, locality, freshness,
   context budget, health/cooldown and explicit charge/consent status.
5. Cloud-primary is an owner-selectable strategy for approved nonprivate tasks;
   local-first is the privacy-preserving default. No unexpected paid fallback.

## Enterprise self-hosted topology

- **Device data plane**: local agent, isolated worktrees, local Ollama,
  bounded code indexing, quality-gate execution and filesystem ledger.
- **Control plane**: scoped enrollment, grants, job leases, presence,
  route policy metadata, audit verification and optional brokered connectors.
  Operational counters must remain small and not contain code.
- **Optional managed service**: user/account billing, approved private GitHub
  mediation, marketplace and cross-device collaboration. Local-only workflows
  must not depend on those to execute an already-authorized local task.

Do not infer zero server CPU: TLS, authorization and synchronization necessarily
consume resources. Measure idle CPU, memory, tail latency, and bytes/request
before making a low-cost claim.

## Acceptance sequence

| Priority | Release gate | Evidence |
| --- | --- | --- |
| P0 | Truthful dashboard, no fake model/device counts | Live signed-agent reports, unknown/stale negative tests |
| P0 | Safe developer onboarding | OS-confirmed loopback session, redirect allowlist and wildcard rejection tests |
| P0 | Reliable local-first routing | Quota/429/timeout simulation, real P720 Ollama tool call, no billed request |
| P0 | Autonomous task completion | Real lease -> worktree -> patch -> exact-head gates -> owner-reviewed PR |
| P0 | Production deploy parity | Exact SHA for all public MCP origins, same catalog, authenticated smoke |
| P1 | Stable signed upgrades | Published detached signature, staged device install, observed rollback |
| P1 | Client UX | Claude Desktop, Cursor, Roo Code, ChatGPT OAuth and actual tool-call demos |
| P1 | Enterprise durability | External ledger anchors, recovery drill and scoped multi-tenant isolation |
| P2 | Scale tuning | Benchmarks for 1/10/100/1000 active nodes, P95/P99 SLO with stated hardware |

No green source CI or proposal replaces the real-world acceptance gates.
Keep the commercial general-availability label gated until all P0 gates pass.
