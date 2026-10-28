# KMJ CodeBridge — Claude engineering guide

You are working on a security-sensitive, customer-device MCP product. Follow existing repository policy, tests, PR conventions, and user authorization rules. **Do not interpret this document as permission to bypass security checks or to run unrestricted shell.**

## Active owner-priority mission (2026-10-12)

**Universal Local AI Development Engine:** implement secure project-scoped local PC build, testing, packaging and release flows, operated from compatible AI chats/IDEs. Read and follow the authoritative requirement and acceptance contract:

- [docs/UNIVERSAL-LOCAL-DEVELOPMENT-ENGINE.md](docs/UNIVERSAL-LOCAL-DEVELOPMENT-ENGINE.md)

Start with **M0 inventory/contracts** then **M1 real Windows P720 secure build runner**. Deliver actual source, tests and reviewable PRs, rather than just project plans. Do not report features as implemented merely because the blueprint exists.

### First work slice (specific)

1. Fetch latest `main` and inspect `src/tools.js`, `src/policy.js`, `src/agent*.js`, `src/jobs.js`, existing configured gate and command-profile tools, Autopilot leases, worktree lanes and safety tests. Check for another Claude/ChatGPT PR before changing files.
2. Produce a versioned, deny-by-default command-profile schema and compatibility matrix. Preserve existing named quality-gate contracts. No arbitrary command execution from AI-provided freeform text.
3. Add a tested Windows local runner for approved **Node** and **CMake/Qt/CTest** build/test profiles, with pinned worktree, bounded runtime/log/resource usage, cancellation, receipt hashes, and strict path/executable validation. Keep explicit project/device/operator grants and avoid running against production data.
4. Prove executable build/test receipts on the authorized P720 and separate CineCore project **without disrupting the other agent**. Where real graphical interaction is needed, require user consent and label its status pending until proven.
5. Open small PRs; verify exact SHA against official free CI and independent local checks, publish PASS/FAIL and remaining blockers. Only proceed to GUI/HIL and release factory once the safe runner is proven.

### Known separate work

- `kmjtechno/kmj-main-platform` **PR #379**: CodeBridge Device Control Center.
- **PR #381**: stacked modular Control Center (usage/billing/settings UI), based on #379; free CircleCI exact head passed on 2026-10-12.
- **PR #380**: long OAuth state round-trip fix for Gemini Spark; code-level native tests passed, hosted CI/production user acceptance not proven.
- Do not rewrite or merge these branches from this repo. Submit dedicated, backward-compatible integration contracts as needed.

**Persistent CodeBridge capability onboarding:** For a new CodeBridge-related
chat or a request to "resume / continue / use all features", use
`chat_workspace_open` with the authorized device/project and stable lane
`codebridge-24x7` (or the project's existing saved lane) before asking the
owner to repeat feature lists. Read its current `capabilities.liveCatalog`
when supported: this is a read-only, device-scoped policy inventory with
runtime/model/worker hints, **not** a grant or proof every listed tool works.
On an older gateway that does not expose this field or tool, fall back to
`policy_catalog`, `inspect_project`, `chat_continuity_read` and live
worker/model/updater status; save only a bounded sanitized handoff using
`chat_continuity_save` with revision precondition. Do not promise native
ChatGPT memory, access to past chats, live 24/7 inference, or unrestricted root
permissions from a catalog listing. Recheck protected operations on every
action, not just once per chat.

### Safety, cost and honesty

- Prefer native CodeBridge MCP tools: `inspect_project`, `project_environment`, `policy_catalog`, `git_status`, hash-precondition edits, `run_quality_gate`, `get_job_status`.
- All writes scoped to project, grants and expected SHA. Never reveal or persist API tokens in PRs/logs.
- Do not presume unrestricted shell, OS admin rights, external paid APIs, code-signing certificates, Docker, Android SDK or Mac/Xcode. Detect and report missing prerequisites.
- No paid CI upgrade, privileged service restart, unreviewed production deployment, DNS change, real payment, destructive reset or release publication solely because the owner approved engineering development.
- Do not falsify live device status, token usage, installer readiness, end-to-end GUI tests or release completion.
- Report each slice as `repo / PR / head SHA / device / exact commands or gate / test PASS/FAIL / CI / artifact hashes / blockers / next step`. Continue only while this session has tools and explicit authorization.

This is a project handoff, **not an instruction to autonomously spend money or bypass release approvals**.
