# Implementation ledger — plan: docs/superpowers/plans/2026-09-29-codebridge.md

- User authorized implementation and GitHub upload on 2026-09-29.
- Repository discovered: kmjtechno/kmj-codebridge, main e623cbbda2c71a882447838348e0c82cfb99335f; contains README only.
- Isolated scratch checkout on feat/codebridge-preview, no production files touched.
- Ruling: Node 24 agent for the executable first preview because Rust is not installed and an official MCP SDK is available. Cost: greater idle memory; native replacement remains roadmap work.
- Ruling: build distributed developer preview rather than pretending full M0-M8 commercialization is delivered. Actual Main Platform keys/contracts and a permanent gateway host are not available.
- Ruling: direct user request to build and upload supplies execution authorization; proceed inline without an extra plan-only approval round.
- Pre-flight: policy and job interfaces consumed only by tools; tools consumed by agent; authenticated gateway forwards requests without access to project files.

## Verified implementation observations

- Task 1: scoped file implementation passed 20 tests after missing-module RED run.
- Task 2: license/job implementation passed 22 tests after missing-module RED run.
- Task 3: real official-SDK MCP client/gateway/agent workflow passed all initial 6 tests.
- Task 4: configuration and plugin-source tests added; formatting, syntax and npm audit run.
- Independent reviewer identified cancellation descendant escape, Git ancestor scope leak, response buffering and entitlement-file placement gaps.
- Final fixes: heartbeat-based descendant regression RED -> GREEN; Git ancestor disclosure RED -> GREEN; streaming body cap test -> GREEN; license file placement RED -> GREEN.
- Additional regression: redacted file content must not overwrite original secrets; RED -> GREEN.
- Ruling: `/proc/PID` is not a valid liveness oracle in this runtime's namespace; heartbeat files prove descendant termination. Cost if wrong: false confidence in process cleanup; the heartbeat test remains in CI.
- Known preview limits remain explicit in STATUS.md and SECURITY.md, including host isolation, live Main Platform integration and public ChatGPT authentication.
- Final local verification: 58 tests passed, 0 failed, 0 skipped on Linux/Node 24; formatting and syntax checks passed. Production dependency audit reported 0 vulnerabilities at inspection time. Windows results are pending GitHub CI.

## Configuration destination hardening

- Found a pre-existing setup path bug: lexical outside-project paths could resolve through a symlink/junction into an authorized project.
- Two regressions failed before the fix: in-project alias secret creation and noncanonical stateDir persistence.
- Canonicalize the existing destination parent before checking project containment and creating any credentials. Existing destinations still fail closed.
- Both regressions now pass; complete Linux suite: 87 passed, 0 failed, 0 skipped. Formatting and syntax checks pass.
- This protects against pre-existing path aliases; hostile concurrent filesystem mutation still requires OS isolation, as documented for the developer preview.

## Multi-client MCP support (ChatGPT + Claude)

- Requirement: vendor-neutral bridge with first-class Claude.ai, Claude Desktop and Claude Code support; existing OpenAI integration preserved; one backend, no forked tool semantics.
- Inspected main 0b861ba (all feature branches already merged). OpenAI-specific pieces found: `extensions.com.openai` in plugin.json (already isolated), OpenAI `_meta` keys emitted by the gateway, and "Never imply endorsement by OpenAI" in the skill.
- Verified current requirements from official docs: Claude Code plugin manifest, marketplace and MCP references (code.claude.com) and connector authentication (claude.com/docs/connectors/building/authentication).
- Ruling: Claude support is standard MCP, so no Claude-specific server code. Changes are protocol-level (titles, RFC 9728 path-suffixed metadata) and packaging. Cost if wrong: a client needing a nonstandard field would fail discovery; interop tests pin current behavior.
- Ruling: OpenAI `_meta` extensions stay on for all clients inside `src/client-extensions.js` rather than branching on client identity, because MCP `_meta` is an open extension point and identity-based branching would fork semantics.
- Ruling: Claude Desktop uses remote custom connectors, not `claude_desktop_config.json` (stdio only), so no Desktop artifact is shipped.
- Workspace limit: npm registry returned 403 under organization egress policy; `@modelcontextprotocol/sdk`, `jose` and `zod` could not be installed and local Node was 22. Only dependency-free suites ran locally; MCP interop tests are CI-only.
- Local verification: `tests/client-packages.test.js` 6/6 passed including the real `claude plugin validate --strict` run; `tests/secrets.test.js` 3/3 passed; generated plugin installed into an isolated Claude Code config (1 skill, 1 MCP server); prettier and syntax checks passed.
- First CI run on 57e25ea (CodeBridge CI #13, PR #2): all jobs green. `clients`: MCP interop contract 11/11 passed on Node 24 with the real SDK; package contracts 5 passed, 1 skipped (Claude CLI absent). `verify` ubuntu 106 passed/1 skipped of 107; windows 103 passed/4 skipped (3 pre-existing platform skips plus the Claude CLI test); `distribution` built all three packages with 0 credential findings.
- Follow-up: the `clients` job installs pinned Claude Code 2.1.285 and sets `CODEBRIDGE_REQUIRE_CLAUDE_CLI=1`, so the official `claude plugin validate --strict` check is an enforced CI gate instead of a skip. The validator needs no login; it runs with an isolated `CLAUDE_CONFIG_DIR`.

## Claude Code marketplace (self-hosted plugin)

- Requirement: make CodeBridge installable as a Claude plugin quickly.
- Ruling: publish the repository itself as a Claude Code marketplace with a plugin whose endpoint and token come from `userConfig` (token `sensitive`), because no hosted KMJ endpoint exists and committing or inventing one is prohibited. Cost: users must run their own gateway; OAuth-only gateways use `claude mcp add` instead.
- Verified against current docs: `${user_config.KEY}` is allowed in remote MCP `url` and `headers`; the directory requires a README of 40+ words and a license in the plugin folder.
- Local verification: `claude plugin validate --strict` passes for the repository marketplace and `claude-plugin/`; marketplace add, install and `--values-stdin` configuration succeed in an isolated Claude Code 2.1.285 profile, with the token kept out of settings.
- Not done: license selection and Anthropic directory submission, both owner decisions.
