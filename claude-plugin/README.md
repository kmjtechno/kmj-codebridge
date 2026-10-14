# KMJ CodeBridge for Claude

![KMJ TECHNO](assets/logo.png)

KMJ CodeBridge connects Claude to projects on computers and VPSs you explicitly
authorize. The public plugin uses KMJ TECHNO's OAuth-protected MCP endpoint at
`https://kmjtechno.com/mcp`; it contains no API key, bearer token, or device
credential.

## What this plugin contains

- One `codebridge` skill with the shared safety rules used across supported
  AI clients.
- One remote Streamable HTTP MCP server named `codebridge`.
- Branding, license, privacy, and terms files.

## Connect

Enable the plugin and choose **Connect**. Claude discovers the OAuth
authorization server from the MCP protected-resource metadata and opens the KMJ
account-linking flow. Only devices/projects authorized for that account are
exposed.

Claude Desktop installations using a third-party inference **Gateway** profile
manage remote MCP servers in **Inference configuration → Connectors**. In that
mode add `https://kmjtechno.com/mcp` as a Streamable HTTP server and use
OAuth auto-registration; the account-level plugin Connect control may be
unavailable in that deployment profile. If a previously working connector gets
stuck on `invalid_client`, re-add it and use a freshly registered public OAuth
client instead of retrying the stale registration. Leave the client secret
blank. Claude Desktop managed MCP may use an RFC 8252 loopback callback with an
ephemeral local port; the CodeBridge authorization server supports that
port-varying loopback behavior while keeping PKCE mandatory.

## Claude Desktop connection and icon troubleshooting

**Installed** and **connected** are different states. If the plugin detail page
says **"You're not connected to codebridge yet"**, choose **Connect** and
complete KMJ TECHNO browser OAuth. Do not treat an installed ZIP or a gateway
health check as an authenticated AI agent.

If **Connect** is disabled, does not open the browser, or returns to the same
screen without a successful authorization, use Claude Desktop
**Customize → Connectors → Add custom connector** with:

- Name: `KMJ CodeBridge`
- Remote URL: `https://kmjtechno.com/mcp`
- Complete the normal OAuth flow. No device or API token belongs in the form.

In third-party inference Gateway mode, use **Inference configuration →
Connectors → Managed MCP servers** instead. After connecting, verify a
read-only `connection_overview` before using write/execute permissions.

To diagnose without changing an account, a developer with Node.js can run
`node scripts/diagnose-claude-desktop-oauth.mjs` from the repository. It
checks ONLY public HTTPS OAuth discovery, never registers a client or reads
tokens. **DISCOVERY_READY_ONLY is not a connected Claude plugin.**

**Branding:** the committed `assets/icon.png` is the original KMJ TECHNO
red/black 3D K mark; the screenshot's Laravel-looking icon is **not this
file**. Claude can show an issuer/remote-connector icon from a public website
or its own default, separately from this plugin manifest. The production OAuth
site at `https://kmjtechno.com` must serve a verified locked KMJ icon and
the gateway's optional `iconUrl` must reference real, correctly hosted
image bytes; updating the ZIP alone cannot force Claude's remote connector
badge. Never replace the locked K with a flat white-square K or claim a live
visual pass from package tests.

**If OAuth still fails, record only the redacted error code
(e.g. `invalid_client`, `invalid_redirect_uri`, `state_mismatch`,
`PKCE`, or `403`) and the screen after pressing Connect.**
Do not share a full authorization URL, callback URL, authorization code,
cookies, API keys or access tokens.

## Self-hosted deployments

The repository remains self-hostable. Operators who run their own gateway should
generate an endpoint-specific Claude package instead of editing this public
plugin:

`npm run package:claude -- https://YOUR-HOST/mcp`

For static bearer developer deployments use the documented `bearer-env`
mode; never embed a credential in a plugin archive.

## Data flow

Claude sends MCP tool calls to the configured CodeBridge gateway. CodeBridge
routes authorized work to the outbound device agent, which enforces project
scope, guarded writes, secret redaction, and administrator-defined quality
gates. Tool results return to the Claude conversation.

## Commercial terms

Plans and licensing are controlled by KMJ Main Platform. The plugin does not
silently create a subscription or place credentials in source control.

## License and policies

The plugin files are Apache-2.0 licensed. Hosted-service use is also subject to
`TERMS.md`, `PRIVACY.md`, and the policies published by KMJ TECHNO.
KMJ CodeBridge is not affiliated with or endorsed by Anthropic or OpenAI.
