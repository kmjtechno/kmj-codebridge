# KMJ FreeLLMAPI-only Model Fabric and selective Agent Skills

Status: source implementation candidate, not an enrolled-device activation, no live provider inference verified. This changes no account, FreeLLMAPI router settings, API keys, owner consent, signed service or production system.

## One model execution point

All **new skill-backed AI generation** flows through the *existing* `freellmapi_generate` CodeBridge MCP tool on the authorized device. There is no direct OpenAI/Anthropic/Gemini/Codex/SDK model call, local Ollama fallback, separate swarm, shared secret copy, paid provider or new service.

- Call `skill_recommendations({device,project,objective,changedFiles})`. Its existing `skills` output is preserved; `fabricSkills` adds nine original, bounded optional workflows.
- To run an explicitly approved workflow, call `freellmapi_generate({device,project,skillId,prompt,localProcessingApproved:true,upstreamCloudApproved:true})`, only after the owner's permission and external source-transfer/data policy authorizations. The selected skill sets a deterministic `code` or `reasoning` task preference; FreeLLMAPI chooses only allowed, advertised `auto:<chain>` routes.
- **The trusted chain verifier remains mandatory**. The existing FreeLLMAPI adapter denies all generation without current authenticated zero-cost, account, quota, pinned route and no-paid-fallback evidence. This proposal does not supply or fabricate that proof.
- Output is **untrusted advice**, not applied code. Worktrees, fixed-gate tests, exact-head CI, owner approval and Elite signing remain independently enforced.

## Curated workflows

| ID | Specialization | Upstream ideas (no code vendored) |
| --- | --- | --- |
| cross-repo-contracts | Cross-repo API/ABI and contract validation | GitHub Spec Kit, OpenSpec |
| qt-cmake-engineering | Qt 6/QML/CMake/CTest | Qt Agent Skills |
| laravel-php-engineering | Laravel migrations/auth/queues/mail | Laravel Boost |
| rust-concurrency-ffi | Rust Send/Sync, unsafe, concurrency | Trail of Bits |
| react-frontend-performance | React/Next.js performance and a11y | Vercel agent-skills |
| security-differential-review | Security diff, threat boundaries and negative testing | Trail of Bits skills |
| github-actions-hardening | CI permissions, injection and exact SHA | GitHub guidance |
| skill-supply-chain | Third-party skills injection/licensing review | Agent Skills Spec; Cisco Skill Scanner |
| polyglot-quality-matrix | Node/Python/PHP/Rust/Go/.NET/Java/Qt fixed gates | Aider/SWE-agent design patterns |

Upstream license, pinned commit and dependency reviews are required **before** actually vendoring third-party text, binaries or scripts. This PR contains **original KMJ workflow instructions** only. Never auto-install, auto-execute or copy remote skill code without audit.

## Deprecation/removal boundary

Do not remove production commands, historical signed-release workflows, P720 rollback references, safety checks, old MCP aliases or customer-facing contracts on a blind feature-name match. First inventory actual imports, script references, active deployments and compatibility against enrolled old agents; replace with tested generic profiles and mark obsolete paths deprecated. No source files are deleted in this slice.

## Acceptance

1. Pure skill-selection tests and full existing seven-pack compatibility pass.
2. An authorized MCP run with synthetic verifier sends only to FreeLLMAPI loopback; invalid skill, denied grants or absent consent send no prompt.
3. A separately verified real-owner FreeLLMAPI zero-cost account/route receipt and consent is required before any production inference.
4. Track exact current branch SHA and CI; only a reviewed PR is eligible for merge, and merge is not agent activation or signed deployment.
