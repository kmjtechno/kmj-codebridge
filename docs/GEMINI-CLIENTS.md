# Gemini web, desktop, CLI and Code Assist — verified compatibility

KMJ CodeBridge uses one vendor-neutral **OAuth-protected Streamable HTTP MCP** endpoint: `https://kmjtechno.com/mcp`. Google products have different capabilities; do not treat them as interchangeable.

| Google client | CodeBridge MCP path | Verified qualification |
| --- | --- | --- |
| Gemini CLI (Windows/macOS/Linux) | Remote MCP `httpUrl` and OAuth discovery | Officially supported by Google's Gemini CLI. CodeBridge emits `gemini-json` / `gemini-cli` templates; local setup helper added here. |
| Gemini Code Assist VS Code Agent mode | Gemini CLI MCP settings | Google documents remote and local MCP tools; test OAuth and tool permissions on the actual installed IDE. |
| Gemini web (gemini.google.com) | **Gemini Spark** custom Connected Apps via MCP URL | Google currently requires an eligible US user aged 18+, a personal Google Account, English, and Keep Activity. Not generally available in India; no automatic installation. |
| Gemini official macOS desktop | Native Gemini app with Spark where eligible | Google's desktop app exists. No independent proof that desktop exposes the same general custom-app MCP addition UI; use Gemini web Connected Apps setup if eligible and verify actual desktop tool discovery. |
| Gemini official Windows desktop | Native Gemini desktop app | Google desktop app exists, but native custom MCP tools via desktop settings are **not verified**; do not promise arbitrary MCP plugins or enablement. Use Gemini CLI or Code Assist on Windows instead. |

Google documentation (review when publishing):
- https://geminicli.com/docs/tools/mcp-server/
- https://docs.cloud.google.com/gemini/docs/codeassist/agent-mode
- https://support.google.com/gemini/answer/17209137
- https://gemini.google/desktop/

## Free, one-click-style local Gemini CLI / Code Assist setup

The native helper requires only Node.js and does **not** install a model, fetch paid APIs, open ports or write credentials. It preserves unrelated Gemini preferences and other MCP servers.

```sh
# Preview changes without writing anything
node scripts/setup-gemini-cli.js --scope user --dry-run

# Apply to ~/.gemini/settings.json with an existing-file backup
node scripts/setup-gemini-cli.js --scope user --yes

# Verify the CodeBridge entry without exposing other settings
node scripts/setup-gemini-cli.js --scope user --check
```

For an isolated repository, use `--scope project` from its trusted root. By default it is a dry run and never touches any settings. The installer **refuses** to overwrite an existing different CodeBridge connector or an invalid/symlinked config.

Generated entry:

```json
{
  "mcpServers": {
    "kmj-codebridge": {
      "httpUrl": "https://kmjtechno.com/mcp",
      "trust": false
    }
  }
}
```

After installation, open **Gemini CLI** or Gemini Code Assist Agent mode and run `/mcp` or `/mcp auth kmj-codebridge` when prompted. Authorize only the account/project scopes needed. `trust:false` preserves model tool-call confirmation. Successful server discovery is **not proof** that your project device is online; call `list_devices` and `connection_overview`.

Alternatively generate vendor-native configuration without editing any files:

```sh
node scripts/client-config.js https://kmjtechno.com/mcp --format gemini-json
node scripts/client-config.js https://kmjtechno.com/mcp --format gemini-cli
```

## Gemini web / Spark custom Connected App

Only if your Google account is eligible:

1. Go to `https://gemini.google.com` and open **Settings → Connected Apps** (sometimes under Personal Intelligence).
2. Choose the supported option to add a custom app, enter `https://kmjtechno.com/mcp`, and complete KMJ OAuth.
3. Grant appropriate CodeBridge scopes and review tool permissions. Then verify actual tool calls for the approved device/project.

The current Google Help page says custom Connected Apps are **US / 18+ / personal-account / English** limited and available on Gemini web and mobile after being added from the web. They may not be offered to India-based accounts. This repository cannot grant eligibility, force UI changes, or silently install into Google's hosted app.

## Gemini desktop

Download the official Windows/macOS Gemini client only from `https://gemini.google/desktop/`. Its appearance and availability are separate from remote MCP support. A Gemini CLI MCP connection **does not** configure the consumer Gemini desktop application. Where Google does not expose custom MCP actions in desktop, use Gemini CLI or Gemini Code Assist side by side rather than pretending the desktop app has native connectors.

## Existing KMJ security and multi-chat contract

Every client uses the same CodeBridge OAuth permissions, signed license, authorization grants, task leases, isolated worktrees, quality gates and audit rules. Use compact work briefs for lower token use. Neither Gemini free tier nor any chat provider guarantees unlimited inference, unlimited concurrent sessions or global feature availability.

**Release evidence required:** Gemini CLI setup unit tests and general CodeBridge CI, then live Gemini CLI OAuth login, successful `list_devices` / `inspect_project`, and scoped non-destructive quality gate on an authorized device. Web/Spark or official desktop app claims require separate account/region-specific live smoke tests. Source merge alone is not deployed-client verification.
