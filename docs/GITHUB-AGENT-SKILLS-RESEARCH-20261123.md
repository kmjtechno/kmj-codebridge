# GitHub Agent Skills research for KMJ CodeBridge

Research date: **2026-11-23**. Companion to PR #1153 and `docs/ENGINEERING-HYPERSPEED-AUDIT-20261123.md`.

## Executive decision

**Adopt patterns selectively, do not install skill marketplaces wholesale.** A skill is an on-demand instruction package, not a model, tool grant, IDE extension, always-on coding service or proof of free inference. The installed CodeBridge runtime still controls exact project authorization, job slots, signed command profiles, worktree isolation, task journals and release gates.

Every candidate is evaluated as **P0 adopt/adapt**, **P1 project-conditional pilot**, **P2 research only** or **reject as duplicate/unsafe**. Priority describes usefulness, not release readiness.

## Source audit and action matrix

| Upstream                                                                                                 | Concrete skill / pattern                                                                         | KMJ project                  | Priority              | Integration decision                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agent Skills](https://github.com/agentskills/agentskills)                                               | Portable YAML `SKILL.md` + progressive disclosure                                                | All clients                  | P0                    | Follow spec; skills must not inject executable grants                                                                                                                            |
| [Superpowers](https://github.com/obra/superpowers) (MIT)                                                 | `systematic-debugging`, `test-driven-development`, `verification-before-completion`              | All                          | P0                    | Map patterns to existing `debugging`, `tdd`, `release-readiness` packs; no duplicate orchestration runtime                                                                       |
| [Superpowers](https://github.com/obra/superpowers) (MIT)                                                 | `dispatching-parallel-agents`, `using-git-worktrees`                                             | Multi-chat                   | P0                    | Use existing lane reservations, bounded per-device concurrency, isolation and exact-HEAD CI; chats are not spawned worker processes                                              |
| [GitHub Awesome Copilot](https://github.com/github/awesome-copilot) (MIT)                                | `diagnose-ci-gate`                                                                               | All                          | P0                    | Evidence-first first failing step, classify source/flaky/environment and compare base SHA; adapt into existing CodeBridge CI triage                                              |
| [GitHub Awesome Copilot](https://github.com/github/awesome-copilot) (MIT)                                | `codebase-memory-mcp` evidence levels                                                            | Large repositories           | P0                    | Adapt Scout/Verify/Auditor evidence tiering to existing HyperIndex/repo_map; no second unapproved project index/MCP server                                                       |
| [GitHub Awesome Copilot](https://github.com/github/awesome-copilot) (MIT)                                | `ai-team-orchestration`, `api-breaking-change-detector`                                          | Multi-repo                   | P1                    | Producer/implementer/QA role workflow mapped onto mission DAG and shared API contract receipts; no fictional concurrent agents                                                   |
| [Laravel Boost](https://github.com/laravel/boost) (MIT)                                                  | `laravel-best-practices`, `testing-best-practices`, version-aware docs                           | Main Platform                | **P0 targeted**       | Pilot source-only guidance first; Boost MCP and Composer dependency install require explicit approval and isolated build/QA                                                      |
| [Qt Company R&D](https://github.com/TheQtCompanyRnD/agent-skills) (BSD-3-Clause or Qt commercial terms)  | `qt-cpp-review`, `qt-cmake-project`, `qt-qml`, `qt-qml-review`, `qt-qml-test`, `qt-qml-test-run` | CineCore/Calibration         | **P0 targeted**       | First use approved compatible source review; do not execute upstream Python linters, subprocesses or tests outside fixed profiles                                                |
| [Trail of Bits Skills](https://github.com/trailofbits/skills) (CC-BY-SA-4.0)                             | `rust-review`, `modern-cpp`, `agentic-actions-auditor`, `supply-chain-risk-auditor`              | OmniDesk/CineCore/CodeBridge | P1                    | Read-only references and original security observations; **do not copy contents into Apache codebase** without license review. Raw Bash/agent grants conflict with default scope |
| [Vercel Agent Skills](https://github.com/vercel-labs/agent-skills)                                       | `react-best-practices` (per-skill MIT), `web-design-guidelines`                                  | React/Next UI _only_         | P1 conditional        | Apply only when manifest proves React/Next; irrelevant to native Qt, PHP backend and Rust                                                                                        |
| [Anthropic Skills](https://github.com/anthropics/skills)                                                 | `skill-creator`                                                                                  | Skill maintenance            | P1                    | Adopt eval prompts and trigger tests conceptually; inspect per-skill license and external script behavior                                                                        |
| [Cisco Skill Scanner](https://github.com/cisco-ai-defense/skill-scanner) (repository LICENSE Apache-2.0) | Best-effort scan for agent-skill prompt injection/exfiltration                                   | Supply chain                 | **P0 gate candidate** | Research source-only first; run in disposable restricted CI runner after dependency security/licensing review, interpret findings as advisory                                    |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) (MIT)                                                 | Spec-change/implementation task workflow                                                         | Complex features             | P1                    | Borrow one owning spec + per-repo acceptance workflow; keep CodeBridge's current mission/task journal instead of a second task DB                                                |
| [Microsoft Skills](https://github.com/microsoft/skills) (MIT)                                            | Azure SDK/.NET/identity/cloud-specific skills                                                    | Relevant projects only       | P2                    | Trigger only if a selected repo actually uses the SDK/service, no new Azure/Google cloud dependency                                                                              |
| [Sentry Skills](https://github.com/getsentry/skills) (Apache-2.0)                                        | Code review, PR writer, simplifier, CI security                                                  | All                          | P2                    | Useful checklist ideas but heavily overlap existing `skill-packs.js` and review workflows. Avoid bulk copying                                                                    |
| [rewrite-rs](https://github.com/rewrite-rs/skills) (BSD-3-Clause)                                        | Rust idioms and cross-language migration                                                         | OmniDesk only                | P2                    | Optional review when ownership/FFI modernization emerges; small/new upstream, pilot against real Rust test cases                                                                 |

Repository and individual skill licenses may differ. Date, grant boundaries, executable scripts and upstream commit must be rechecked before vendoring or production enablement. This is an architecture research report, not a claim to have executed these skills.

## P0 reference skill recipes (native CodeBridge, no extra model spend)

1. **`repro-root-cause`** — on `failure|bug|test regression`, read exact failing logs, capture reproduction and first error, check recent diff, isolate cause before edit, add regression test, run approved gate and exact-head CI. Derived workflow concept from Superpowers debugging.
2. **`ci-triage`** — on PR red check, get latest head SHA, failing job and _first failing step_, classify code bug vs flaky vs infrastructure vs misconfigured pipeline; compare base before retry; create one bounded fix candidate. Use existing `github_actions_failed_job_triage` and receipts. Derived concept from GitHub `diagnose-ci-gate`.
3. **`verified-completion`** — before any task completion, independently re-read exit code, toolchain, source SHA, changed files, artifacts, exact-head CI, review and release state. Never trust an AI's `PASS` declaration.
4. **`impact-aware-code-search`** — first look up current index status and path/coverage metadata, search relevant paths, verify definitions/callers in source. Distinguish provisional Scout from verified impacted code, never assert absence from truncated indexes.
5. **`parallel-engineering`** — choose independent tasks, decompose into worktrees and scoped leases, limit by actual device slots and approved model quota, merge only after contract/integration reviews. Never equate multiple chat prompts with independent continuously executing workers.
6. **`language-profile`** — inspect project manifests, choose the relevant approved Node/PHP/Python/Rust/Go/Qt/.NET build/test profile; missing profile is a guarded setup request, not blanket shell authorization.

These should be evaluated as triggering/selection cases against the existing deterministic `src/skill-packs.js` and `evals/skill-selection.json` before adding separate duplicate user-facing tools.

## Product-specific pilot details

### Main Platform — Laravel Boost

Use official version-compatible Laravel/PHP guidance for Eloquent performance, policies, signed authorization, migrations, queue/retry, mail, scheduling and test isolation. **Never** use a skill to automatically run production migrations, modify billing, delete customer data or install Composer dependencies. Pilot source-only on a Laravel feature PR, then an approved disposable QA command profile. Version-detect actual composer lock/framework.

### CineCore and Calibration Studio — Qt

Use official `qt-cpp-review` for QObject ownership/thread safety, signals/slots and C++ API; `qt-cmake-project` for existing CMake structure; `qt-qml` only where QML exists; `qt-qml-test-run` only after the exact Qt SDK and runner exist in an isolated Windows lane. Qt skill's readme links to Qt AI Services terms; independently review applicable contractual obligations. Figma/visual components need locked design agreement and real UI screenshot comparisons.

### OmniDesk — Rust

Use scoped ownership/FFI/concurrency/unsafe review concepts; preserve true Windows service/IPC/network permissions, no unapproved terminal or host Docker socket. Reproduce relevant tests and verify signed/licensing integration with Main Platform separately.

### CodeBridge itself — Node/MCP

Prioritize CI-first debugging and skill-supply-chain guard. Review third-party skill instructions and bundled scripts as hostile data. Current CodeBridge security-critical runtime should remain its own protected test, MCP grants and owner-signed release path.

## Security and license acceptance before third-party install

- Pin exact upstream commit SHA and record source/license/last update and path manifest; scan `SKILL.md`, references, scripts, hooks, workflows, dependencies and binaries.
- Reject anything that requests unrestricted network, credentials, home-directory reads, arbitrary shell, automatic model substitution, account impersonation, production/root access, cleanup/reset or hidden background agents.
- Run best-effort static prompt-injection/secret/exfiltration checks and a separate manual review. Passing a scanner does **not** prove safety.
- Restrict external skill execution to explicit reviewed fixed CodeBridge profiles and disposable sandbox/worktree. Avoid running third-party installer or `npx -y` on Elite production.
- Respect MIT/Apache/CC-BY-SA/BSD/Qt licensing and their notices/terms. Prefer linking and original derived procedures to blind copying.
- Enforce `privateCodeAllowed`, owner cloud-source-transfer approval and independently attested zero-cost inference before any external LLM use. Fail closed; local fallback is disabled under current owner cloud-only policy.

## Measurable acceptance

- Skill trigger precision on positive/negative scenarios; no irrelevant skill activation.
- Correct diagnosis on seeded CI flakes, root-cause tests and historical regressions.
- Two independently authorized chats resume the same roadmap and accept one task each without duplicate claims or cross-project leakage.
- Safe parallel isolated task completion across two distinct repos with exact-head CI, no lost writes and actual resource/cost receipts.
- Pilot PHP/Laravel, Qt/CMake and Rust codebases with real approved toolchains on correct operating systems.
- Compare baseline vs skill-enhanced task time p50/p95, context/token bytes, CI retries, code defects and monetary spend. Speed claims require measured data.

**Status:** Research and reference shortlist only. No upstream package, model, script or agent is installed by this report. Implement in small independent PRs behind existing grants.
