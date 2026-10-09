# P720 CineCore + Claude Code — Authorized Worker

**Scope:** An independent Windows CodeBridge agent for the existing CineCore checkout at `D:\KMJ-HyperSpeed\projects\kmj-cinecore`. It does not reuse the CodeBridge project's token or change that project, existing models, or production services.

## One-click

1. Double-click `START-KMJ-P720-CINECORE-CLAUDE.cmd` on the P720. It fetches the current CodeBridge `main` branch by clean fast-forward only; it never resets the CineCore checkout.
2. Approve the **new** device beginning with `kmj-p720-cinecore-`, for **only** project `kmj-cinecore`, and read/write/execute scope in the KMJ browser account.
3. The independent agent stores credentials under `D:\KMJ-HyperSpeed\private\p720-cinecore\` with current-user-only ACLs. It uses the VPS gateway at `https://kmjtechno.com/` after an unauthenticated HTTP 401 check.
4. Send only `D:\KMJ-HyperSpeed\P720-CINECORE-AUTH-RESULT.txt`. **Never send** private `agent.json`, `enrollment.json` or backup secrets.
5. Verify the new device and project in CodeBridge `connection_overview` before executing remote jobs. A local heartbeat is not sufficient.

**License enforcement:** Main Platform checks active licenses and device-count policy. A denied pairing or device limit is a real blocker and is not bypassed. A different device/project must be separately approved.

## Claude Code

The setup detects an existing Claude Code CLI and tries to add a **local-scoped** HTTP MCP entry named `kmj-codebridge-cinecore` pointing to `https://kmjtechno.com/mcp`, without static bearer credentials. From the CineCore project folder, open Claude Code and use `/mcp` to sign in to KMJ. If not already configured, run:

```powershell
claude mcp add --transport http --scope local kmj-codebridge-cinecore https://kmjtechno.com/mcp
```

Claude account subscription/API usage is separate from free CodeBridge operation. Claude must still have permission to use the requested project and any file edits.

## CineCore quality gates

- `cinecore_configure`: MSVC 2022 x64 with Qt6 and tests ON, D3D12 enabled; uses pre-existing Qt 6.7.3 or CMAKE_PREFIX_PATH.
- `cinecore_build`: Release build, 12-way parallelism.
- `cinecore_ctest`: CTest Release, failures printed.

Missing MSVC, Qt6 or CMake remains a BLOCKED build prerequisite; enrollment does not secretly install them. No GitHub self-hosted runner is added.

Claude must read CineCore `AGENTS.md`, `CLAUDE.md`, the YAML roadmap, latest handoff, QA issues and test matrix before changing code. Preserve D3D12, LEFT/RIGHT stereo, real-time safety, no fabricated readiness, and locked KMJ branding. Work on a feature branch and report actual CI/hardware test evidence.


## P720 staged one-click CodeBridge runtime refresh

On the authorized Windows P720, launch `scripts/START-P720-CINECORE-SAFE-REFRESH.cmd`. It safely fetches and fast-forwards only a **clean** trusted CodeBridge `main` checkout on D:, then runs `scripts/p720-guarded-cinecore-refresh.ps1`. It never resets or overwrites the separate `kmj-cinecore` checkout or Claude edits.

The refresher validates the existing **single-project** CineCore token, device, tenant and project scope locally, without printing credentials. It stages the exact CodeBridge Git commit under `D:\KMJ-HyperSpeed\runtime\codebridge-cinecore\revision-<sha>` while the old worker keeps running. The staged runtime runs pinned `npm ci --ignore-scripts`, `npm run check` and `npm test` before any restart; no paid AI/API is used.

Only if the CodeBridge job journal has **no running or queued tasks**, the process command line and Node executable match this CineCore config, and the private `agent.lock` PID agrees, does the script stop precisely that agent. Two idle checks are required. Native Windows `Stop-Process` is not a graceful drain, and a narrow check-to-stop race remains; run this only during an idle development window, never during physical motion operation or while Claude is sending work.

A fresh authenticated `connected` heartbeat is required after startup within 45 seconds. If it fails, the script attempts a scoped stop and starts the previous unchanged runtime, requiring another fresh heartbeat. An ambiguous state returns BLOCKED rather than force-resetting anything.

Safe report: `D:\KMJ-HyperSpeed\P720-CINECORE-SAFE-REFRESH-RESULT.txt`. Never share private `agent.json`, `enrollment.json`, `state`, lock, or any token. This is a **development** refresh, not signed-stable release deployment. Windows CI tests its syntax/policy; successful actual P720 refresh must be verified separately. The gateway MCP tool catalog needs independent deployment before newly added tools appear to remote clients.
