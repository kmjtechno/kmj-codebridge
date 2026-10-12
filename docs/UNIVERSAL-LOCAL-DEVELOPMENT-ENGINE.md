# KMJ CodeBridge — Universal Local AI Development Engine

**Owner-approved product requirement, 2026-10-12.** This is an implementation contract and acceptance plan, **not a claim that all functions already exist or are deployed**.

## Mission

An approved AI chat, IDE, or command-line client should be able to direct a customer's **own authorized computer** through a complete, reproducible software engineering lifecycle: onboard project → inspect → plan → edit → build → test (including real GUI/hardware tests where supported) → diagnose/fix → package → sign (where credentials are available) → stage → release → verify/rollback. Operate local-first, using a lightweight OAuth-controlled gateway with **no dependency on Desktop Commander** or paid remote-shell tools.

Compatible clients include ChatGPT, Claude web/Code/Desktop, Gemini CLI, VS Code/Copilot, Cursor, and other conforming **MCP-capable clients**. Do not promise features for a provider's UI or geography unless that exact client has passed a real interoperability test. All clients share the same authoritative tenant, device, project, permission, license, concurrency, and audit controls.

## Principles that cannot be weakened

1. **Customer PC does the work.** Builds, compilation, tests, local GUI/hardware operations, model inference, artifacts, and caches remain on the authorized device by default. The gateway should handle only authentication, bounded scheduling/routing, status, and audit metadata. No source-code exfiltration or server-side compilation unless explicitly opted into a separately scoped service.
2. **Project-scoped, never arbitrary administrator shell.** A signed/versioned project command profile selects an approved executable, fixed argument template, controlled environment, working directory, max runtime/output, and least-privilege identity. No arbitrary user/client supplied command strings, unbounded pipelines, or execution outside approved project roots. No sensitive environment variables or secrets in chat/logs.
3. **Build and test isolation.** Prefer ephemeral worktrees, sandboxed build directories/containers, immutable inputs where supported, pinned dependencies, provenance (commit/manifest/hash), cancellation, timeouts, bounded disk/memory/CPU/GPU resources, and explicit clean-up. Do not modify the operator's installed tools or production data merely to run tests.
4. **Independent release gate.** A model can propose or build a release; signing, publishing to real customers, modifying production/DNS, privileged installs, and destructive changes require deliberate policy authorization, auditable user approval, rollback plan, and verified checks. CI must be green at the exact release SHA. Never bypass branch protection.
5. **Honest evidence.** Every tool result reports `queued|running|succeeded|failed|cancelled|blocked`, exit code, bounded redacted stdout/stderr, artifact hashes, timings, machine/profile/OS, checked head, and reason codes. Do not call synthetic screenshots, cached logs, emulators, or configuration presence an actual live test.
6. **Free-first, no forced subscriptions.** Use already-owned PC CPU/GPU, free/local models and free CI when available. Avoid paid Desktop Commander dependency, provider model lock-in, hidden charges, or claims of unlimited model access.
7. **Race-safe multi-AI.** Distinct jobs/chats use task leases, owner/expiry fencing, isolated pinned Git worktrees, file reservations and merge conflict checks. A stale worker must not overwrite a new one. Concurrency is measured and limited by hardware and signed entitlements.
8. **Accessible one-click onboarding.** Users add a device/project and select a detected toolchain in the KMJ Main Platform dashboard, then approve narrowly scoped permissions and optionally install prerequisites. Pairing requires browser approval; no GitHub login is required to authorize CodeBridge. Never silently grant READ/WRITE/EXECUTE.
9. **No unsupported universality claim.** Toolchain and OS prerequisites matter: Windows-only SDKs require Windows, Apple-signed native iOS/macOS artifacts require a compatible Mac/Xcode and Apple credentials, real projector/motion/camera acceptance needs suitable hardware, and physical safety interlocks cannot be bypassed by AI.

## Current known baseline (verify again before development)

- CodeBridge project on Windows P720: `kmj-p720-desktop-k3ahhem`, writable, agent 0.3.2; gates `p720_ai_tests`, `scan_secrets`, `check`, `p720_inference`; **no configured general project command profiles** at this checkpoint.
- CineCore uses separate P720 authorization `kmj-p720-cinecore-desktop-k3ahhem`, gates `cinecore_configure`, `cinecore_build`, `cinecore_ctest`. Keep it independent; do not merge permissions/agents carelessly.
- `docs/CLIENTS.md` describes portable MCP client configuration. Client format support is not proof of live GUI/client interoperability.
- CodeBridge already contains policy/catalog, guarded project edits, configured gates, Git inspection, device pairing, job journal/capacity, task leases, isolated worktree lanes, and local model facilities. **Extend these**, do not create an unrestricted duplicate remote-terminal product.
- `kmjtechno/kmj-main-platform` draft #379 (device dashboard) and stacked #381 (navigation, truthful usage/plan UI) are separate integration work. #380 is a distinct Gemini Spark OAuth opaque-state fix. Integrate only with exact-head review and branch safeguards.
- Latest known CodeBridge `main` at handoff: `055fd88ebfd56125abbe2bcec8f99819ed54ae80`. Re-fetch actual remote head before editing; other agents may advance it.

## Architecture

```text
AI clients / IDEs (MCP + OAuth)
          │
KMJ Main Platform: tenants, plans, billing, user/device/project grants
          │
Hosted CodeBridge: OAuth validation, MCP policy, bounded job routing,
                   short-lived approvals, telemetry receipts
          │ outbound-only, authenticated, resumable device connection
Authorized local agent(s), per-OS capabilities
          ├─ Command Profile Registry (deny by default; signed/versioned)
          ├─ Build & Test Runner (worktree, sandbox, budgets)
          ├─ GUI/HIL Runner (explicit interactive session + consent)
          ├─ Artifact & Release Factory (hash, SBOM, signatures, manifests)
          ├─ Toolchain Detectors (OS, compilers, SDK, dependency versions)
          ├─ Local Model Adapter (opt-in coding/reasoning; fallback on outages)
          └─ Status / Audit (tenant-scoped, bounded, truthful)
```

### Capability and command profile manifest (proposed, schema-design task)

Add versioned types/schema, backward compatible with current gates:

- Device capabilities: `os`, `arch`, toolchain id/version/path fingerprint, CI runtime support, graphical session/consent, available storage and resource budgets, signing capability **presence only** (never private key data), build targets.
- Project command profile: `profileId`, `projectGrantId`, `toolchain`, `kind` (`configure|build|unit-test|integration-test|gui-test|package|sign|deploy|rollback`), vetted executable ID, fixed or allowlisted argument slots, allowed worktree root, environment allowlist, max duration/resources/output/artifacts, approval risk class, audit retention. Reject shell metacharacter passthrough, path escapes, binary replacement, secret-file access, symlink traversal, and arbitrary URLs for artifact publishing.
- Job receipt: immutable `jobId`, tenant/device/project, request/lease ID, profile version/hash, Git SHA, timestamps, state, exit code/reason, measured resources, log truncation flag, bounded redacted artifacts and SHA-256 digests. Client retry with same request key is idempotent; cancellation and device disconnect are observable.
- Link to Main Platform: authorized registrations and verified gateway heartbeats with TTL; stale/unreachable displays `unknown`, not fabricated `online`. Usage metrics should count **measured**, tenant-bound events, not estimates presented as invoices.

### First-class development targets (implement progressively)

| Target               | Example profiles                                | Acceptance evidence                                                     |
| -------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| JS/TS/web SaaS       | Node, npm/pnpm, Vite, Playwright                | isolated unit/e2e, deterministic web smoke                              |
| Python               | venv/uv/pip, pytest, lint, packaging            | offline/fail-closed dependency guard, wheel hash                        |
| Windows C++/Qt/CMake | CMake presets, MSVC/Ninja, CTest, Qt deployment | real Windows binary, process launch, GUI screenshot receipt             |
| .NET                 | dotnet restore/build/test/publish               | test report and signed/hash manifest                                    |
| Containers/Linux     | Docker/Podman, gcc/clang                        | image digest, isolated container test                                   |
| Android              | JDK, Gradle, Android SDK                        | emulator/device test evidence, APK/AAB hash                             |
| Unity/Godot/Unreal   | installed engine toolchains                     | engine-version-bound builds and headless/interactive tests              |
| AI/ML                | Python/CUDA/PyTorch, model runtime              | measured latency, resource envelope, no unapproved model downloads      |
| Industrial/cinema    | CineCore/motion/calibration toolchains          | safety-gated HIL, physical interlock and operator approval              |
| iOS/macOS            | macOS build worker + Xcode                      | real device/simulator evidence, signing with operator-owned credentials |

User-selected project profiles should not auto-install proprietary SDKs or require cloud resources without approval.

## Milestones (strict dependency order)

**M0 — Inventory & contracts.** Recheck existing tools/CLI/scripts and pending PRs to avoid duplicates. Capture machine/OS/toolchain capability detection safely. Specify command profile JSON Schema, stable reason codes and least-privilege execution API, feature flags, tests and upgrade/migration/rollback plan. Deliver concrete PR(s); no production rollout.

**M1 — Universal Build Runner MVP.** Implement on P720 a secure structured profile runner for existing approved CMake/Qt/CTest and Node/npm workflows. Add Python/pytest after that. Profiles operate in project-specific isolated worktrees, fixed timeout/resource budgets, no arbitrary shell; add cancellation/idempotency/log redaction and result receipts. Keep already working legacy gates compatible. Prove a real Windows compile and test on approved test fixture and CineCore without disturbing another agent.

**M2 — Local Live QA.** Optional GUI session broker with visible consent, scoped window/process identity, timeboxed input, screenshot/video capture with privacy redaction, deterministic playback, crash dumps, accessibility and visual-regression baselines. Separate virtual-display automation from actual hardware/device tests; require HIL safety interlocks for cinema/motion. Test network loss/reconnect, minimized/locked session, DPI, GPU driver and reduced-motion scenarios.

**M3 — Release Factory.** Reproducible archives/installers/images, provenance and SBOM, malware/secrets scan, artifact hashes, versioning and changelog, staging promotion, signatures using operator-controlled signers, GitHub Releases via scoped OAuth, controlled release approvals, canary/smoke and rollback. Publishing is opt-in and blocked on missing evidence.

**M4 — Multi-client Autopilot & dashboard.** Task planning, leases, checkpoints, artifact handoffs, conflict-free multi-agent jobs, model fallback. Main Platform shows devices, real job status, verified resources, usage, release candidate approvals, release history, receipts and audit. Cross-tenant access and per-chat consumption tests required.

**M5 — Broader toolchains.** Implement and validate .NET, containers, Android, gaming engines and Mac remote builders as supported adapters; one adapter isn't marked supported until its real end-to-end platform-specific acceptance passes. Publish compatibility matrix rather than a blanket “any software” guarantee.

## Verification matrix (automate where feasible)

- Positive: Node and Qt builds actually produce executables; CTest/pytest produce consistent machine-readable reports; optional GUI test launches executable and records screenshot; artifact is downloadable only to authorized project/user.
- Negative: unauthorized tenant/device/project, expired pairing/grant/lease, spoofed heartbeat, unapproved binary/profile/path, traversal/symlink escape, command injection, secret in logs, missing SDK/signing credentials, out-of-disk/RAM, runaway build, timeout, network loss, killed worker, stale retry, cross-agent merge race, unknown CI status, unsigned artifact, expired approval.
- Release: exact Git SHA+manifest+checks+artifact digest, policy-authorized signer/publisher, rollback verified, zero silent production modification, CI green before any distribution.
- Resource/load: bounded CPU/RAM/SSD, queue/backpressure on P720, 1× then safe concurrent jobs, server load independent of installed customer count.
- Client compatibility: actual OAuth + `list_devices` + `inspect_project` + non-destructive gate on each supported client. Never conflate Gemini CLI with Gemini Spark consumer app.
- Reporting: per milestone `PR | head SHA | tests PASS/FAIL | device | artifacts | security findings | blockers | release evidence`; only measured completion.

## What Claude should do now

Start with M0 and M1 in small reviewable PRs against the **latest** main. Prefer native KMJ CodeBridge tools for project-scoped operations. When a new capability requires a privileged OS bootstrap, create a secure one-click installer with dry-run/backup/rollback and explicit device-owner consent. Do not run unrestricted shell via a tool-policy bypass.

Coordinate separate Main Platform integration (#379/#380/#381) via focused API/schema PRs; leave their current PR branches intact. Do not declare production-ready until a verified end-to-end build → GUI/live test → artifact → release approval → staging smoke → rollback demonstration is available.

**Owner intent:** local PC should be able to produce almost any software that its hardware/OS/toolchains legitimately support, commanded by any _compatible_ AI chat, with minimal user interaction, maximum safety and high-quality results; no forced paid dependency.
