# OpenHands Agent Canvas interoperability (optional, source-only)

This integration uses **official OpenHands Agent Canvas** as a separate, opt-in coding-agent UI and **KMJ CodeBridge** as the existing scoped MCP gateway. It does **not** fork or vendor OpenHands source. The external project and this repository remain separately licensed (OpenHands MIT; CodeBridge Apache-2.0).

- Official upstream: https://github.com/OpenHands/OpenHands
- Agent Canvas MCP settings: https://docs.openhands.dev/openhands/usage/agent-canvas/customize-and-settings
- Agent Canvas Docker backend: https://docs.openhands.dev/openhands/usage/agent-canvas/backend-setup/docker
- Supplied older fork (not selected): https://github.com/AI-App/All-Hands-AI.OpenHands

## Accepted functionality

1. Use Agent Canvas to organize conversations and compatible coding agents, with explicit operator selection. Claude Code, Codex and other ACP-compatible backends are **optional** and must have their own working account/model authorization.
2. Connect CodeBridge by **Streamable HTTP MCP** to `https://kmjtechno.com/mcp` from **Customize > MCP Servers**. Use the supported interactive OAuth flow. Agent Canvas's health display alone is not an authorization or tool-execution proof.
3. Use the optional repository skill `.agents/skills/kmj-openhands/SKILL.md` for scoped, bounded workflows.
4. Run an isolated proof on a disposable clone or feature worktree, make a narrow code change, execute local tests and submit a PR for review. Never auto-deploy.
5. Use only independently proven zero-cost model routes, with no paid fallback. A free software license does not make inference, hosted sandboxes or connected services free.

## Deliberately excluded

- Legacy `AI-App/All-Hands-AI.OpenHands` fork, an entire additional server stack on the existing production host, privileged Docker socket, `--privileged`, untrusted internet-facing Agent Canvas, and whole-filesystem mounts.
- Automatic production edits, root/host shell access, owner signing-key access, secret export, automatic permission grants or bypassed GitHub CI.
- GitHub resolver/action automation, cloud execution or scheduled agent runs by default; these can consume quota or money and need separate verified approval.
- Assumptions that ACP-agent MCP configuration works for every connector/version; validate the exact installed build and agent.

## One-time manual pilot on P520 (no production changes)

1. Obtain an official, pinned Agent Canvas build and check its security notes. Install Docker Desktop/WSL 2 only if compatible and authorized; verify Docker isolation and resource limits **before** running untrusted agent-generated code.
2. Create a **disposable** workspace containing only the project/branch under test. Do not mount `C:\Users`, the system drive, root Docker socket, SSH folders, production `.env` files or CodeBridge gateway credentials.
3. Start Agent Canvas by following the official Docker instructions, bound to localhost and with backend API-key protection. Do not publish its API/UI on a public host.
4. In Agent Canvas, choose **Customize > MCP Servers**, add:
   - Name: `KMJ CodeBridge`
   - Transport: `Streamable HTTP`
   - Server URL: `https://kmjtechno.com/mcp`
   - Auth: use browser OAuth; never paste tokens into this repository or example configuration.
5. Independently verify the OAuth handshake, device `kmj-kmj-codebridge-desktop-5fvjmet`, project `kmj-codebridge`, scoped permissions and the signed CodeBridge gateway. Where the chosen ACP agent does not inherit MCP connections, configure that agent separately and re-test.
6. Set a **verified free-only** LLM route after checking the actual upstream/provider billing and fallback settings. Existing FreeLLMAPI/Zed routes are not automatically accepted merely because they respond.
7. Begin with repository inventory, bounded code review and one test-only PR. Use independent exact-head CI/local test receipts before any protected changes. Keep production cutover outside the pilot.

## Source-only contract

`src/openhands-canvas-interop.js` exports `createOpenHandsCanvasHandoff()`. The default result is `PILOT_BLOCKED`. It prints connection instructions and independent proof gates; it does **not** install anything, ping the MCP server, authenticate OAuth, run an LLM or write files. Caller-provided `*Verified` booleans are **unattested planning hints**, not proof.

```bash
node scripts/openhands-mcp-profile.mjs
node --test tests/openhands-canvas-interop.test.js
```

No service, dependency, production release, workflow schedule or MCP tool registration is changed by this addition. A real sandbox/OAuth/model/agent acceptance test is still required.

## Acceptance for a later activation

- Exact official upstream version pinned, sandbox resource limits demonstrated, workspace-only mount independently checked.
- OAuth and CodeBridge scoped MCP tools confirmed through the actual Agent Canvas/agent connection (not only HTTP `200`), no elevated CodeBridge tool grants.
- Free model billing/fallback path and acceptable task quality attested independently.
- Isolated functional test, negative security tests, rollback and owner-reviewed PR pass.
