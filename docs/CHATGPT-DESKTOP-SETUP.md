# ChatGPT Desktop and registered-app setup

This guide uses the **existing** KMJ CodeBridge MCP registration. Do not create a second app, copy credentials into chat, or register a second MCP endpoint just to repair a local plugin.

## Canonical connection

- Registered app: `asdk_app_6abf4c8dddb08191a983c2bd9fe79732`
- Identity policy: this app ID is owner-locked. Do not replace it from client UI discovery or auto-detection; changing it requires an explicit owner decision.
- Public MCP resource: `https://kmjtechno.com/mcp`
- Repository marketplace: `kmjtechno/kmj-codebridge`
- Plugin source: `plugin/`
- Desktop runtime: `plugin/desktop/bridge.mjs` (optional local stdio path)

`plugin/.app.json` links the portable plugin to the registered hosted app. The OpenAI extension in `plugin/plugin.json` references that file. A self-hosted package generated for a different MCP endpoint omits the KMJ app reference; it must never silently authenticate a self-hosted user to KMJ's deployment.

## Install through ChatGPT Desktop

1. Install or update ChatGPT Desktop, and sign in to the account/workspace that can access the registered CodeBridge app.
2. Open the Plugins Directory and locate the **KMJ TECHNO** repository marketplace. If it has not been added, run `codex plugin marketplace add kmjtechno/kmj-codebridge --ref main` from a terminal with the Codex CLI, or use the provided Windows installer for the personal-marketplace fallback.
3. Refresh the marketplace if already present: `codex plugin marketplace upgrade kmj-techno`.
4. Fully quit and reopen ChatGPT Desktop. Open **Plugins**, select **KMJ TECHNO**, and install/enable **KMJ CodeBridge** if the interface asks.
5. Choose **Connect** for the registered CodeBridge app when offered, then finish the browser authorization with the intended KMJ account. Installation cannot bypass this authorization.
6. Start a new chat and ask CodeBridge to list your authorized devices/projects. A successful OAuth login alone does not prove a device agent is online.

The installer and local marketplace source cannot force a workspace plugin installation, bypass provider consent, or guarantee that an account has access to a privately registered app.

## Windows personal marketplace fallback

Run `scripts/install-chatgpt-desktop.cmd` from the downloaded repository, or use the PowerShell script `scripts/install-chatgpt-desktop.ps1`.

The fallback places the plugin in `~/.codex/plugins/kmj-codebridge` and writes `~/.agents/plugins/marketplace.json`. The personal-marketplace plugin source is **`./.codex/plugins/kmj-codebridge` relative to the home marketplace root**, not a path relative to `~/.agents/plugins/`. Existing unrelated personal plugins remain in the list.

Do not interpret the installer's exit code as proof that ChatGPT has actually installed/connected the plugin. Verify it in the Plugins Directory and test an authenticated tool call.

## Troubleshooting

- **Plugin not visible:** Fully quit/reopen Desktop, confirm the same ChatGPT account/workspace and the selected marketplace, inspect the marketplace's plugin source path, and install from the Plugins Directory. Local Codex plugins may appear only in supported Desktop/Codex surfaces.
- **Failed to install plugin:** Confirm `plugin/plugin.json`, `plugin/mcp.json`, and `plugin/.app.json` exist, and verify that app access is permitted by the ChatGPT account/workspace. The plugin file layout and app authorization are separate checks.
- **No Authorize button:** For a registered app, the UI may instead offer **Connect**. A locally bundled stdio bridge launches browser OAuth on first eligible tool use, but it will not automatically create a remote ChatGPT app connection.
- **Connected but no device:** Check the agent service, enrollment, Main Platform project grant and gateway heartbeat. Do not register another app to fix an offline device.
- **Self-hosted user:** Package that deployment's own HTTPS MCP endpoint rather than reusing the KMJ hosted app ID. Generated packages for custom endpoints deliberately exclude the KMJ app binding.

Only installed/connected client evidence plus an authorized `list_devices`/project inspection call establishes end-to-end success.
