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
unavailable in that deployment profile.

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
