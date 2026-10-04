# AI client support

KMJ CodeBridge is a vendor-neutral Model Context Protocol (MCP) server. Supported
clients use the same gateway, tool definitions, authentication, authorization,
licensing, policy, and audit boundaries.

```text
ChatGPT ─────────┐
Claude.ai ───────┤
Claude Desktop ──┼──► https://kmjtechno.com/mcp
Claude Code ─────┤        │ OAuth · policy · licensing
Future MCP client┘        ▼
                   outbound device agent
                          ▼
                   authorized project
```

## Current hosted-client state

- **ChatGPT:** CodeBridge tools are callable from the current integration; the
  selected target device must still be online.
- **Claude Code:** a real OAuth login completed against
  `https://kmjtechno.com/mcp`; package validation is also enforced in CI.
- **Claude web:** a real custom-connector OAuth flow completed and CodeBridge tool
  permissions were discovered.
- **Claude Desktop, normal account mode:** uses the same hosted OAuth MCP
  resource; account connector sync depends on the Claude deployment/account.
- **Claude Desktop, third-party inference Gateway mode:** configure CodeBridge
  separately under Inference configuration → Connectors → Managed MCP servers.
  One recorded end-to-end tool invocation remains a live release check.
- **Generic MCP clients:** Streamable HTTP interoperability is covered by the
  vendor-neutral CI contract.

External directory approval is separate from technical connectivity.

## Shared contract

- `src/tools.js` is the canonical tool contract.
- `plugin/skills/codebridge/SKILL.md` is the canonical agent instruction source.
- OpenAI-specific MCP `_meta` extensions live in `src/client-extensions.js`;
  other MCP clients may ignore them.
- KMJ Main Platform remains the account, licensing, and commercial authority.
- Client choice never changes project scope or device authorization.

## Claude Code

### Hosted OAuth endpoint

The shortest direct setup is:

```sh
claude mcp add --transport http --scope user kmj-codebridge https://kmjtechno.com/mcp
```

Run `/mcp`, select `kmj-codebridge`, and complete browser authorization. No
static CodeBridge token belongs in the command or repository.

### Public KMJ plugin

The committed repository marketplace now points at the hosted OAuth endpoint and
contains no credential:

```sh
claude plugin marketplace add kmjtechno/kmj-codebridge
claude plugin install kmj-codebridge@kmj-techno
```

### Self-hosted gateway

Operators may generate an endpoint-specific OAuth package:

```sh
npm run package:claude -- https://YOUR-HOST/mcp
```

For a developer-only gateway that intentionally uses a static bearer credential:

```sh
export KMJ_CODEBRIDGE_TOKEN="$(cat /absolute/private-codebridge-config/client-token.txt)"
npm run package:claude -- https://YOUR-HOST/mcp --auth bearer-env
```

The generated package contains only the environment-variable reference, never the
credential itself.

## Claude web and Claude Desktop

The hosted resource is:

```text
https://kmjtechno.com/mcp
```

For Claude web or normal-account Desktop, add it as a custom remote connector and
complete OAuth. CodeBridge publishes the protected-resource metadata needed to
discover the authorization server.

For Claude Desktop running a **third-party inference Gateway** such as a local
model router, account-level plugins/connectors may not be the active connector
source. Configure CodeBridge in:

```text
Inference configuration
→ Connectors
→ Managed MCP servers
→ Add server
→ Blank
```

Use:

```text
Transport: Streamable HTTP
URL: https://kmjtechno.com/mcp
OAuth: Auto-register (dynamic client registration)
```

Then choose **Sign in & test**, complete KMJ authorization, save, and apply the
deployment changes. Do not paste a device credential into this configuration.

Claude Desktop's legacy local `claude_desktop_config.json` is not the path for
this hosted Streamable HTTP service.

## OAuth expectations

The hosted flow uses:

- PKCE S256;
- OAuth authorization-server discovery;
- dynamic client registration where the client requires it;
- RFC 9728 protected-resource metadata;
- the MCP resource URL as access-token audience;
- scoped `codebridge:read`, `codebridge:write`, and
  `codebridge:execute` permissions;
- OIDC identity support in KMJ Main Platform for clients that request
  `openid`.

Main Platform source also contains user/device introspection and verifier-bound
device enrollment. Production configuration flags and live infrastructure still
determine whether a specific account/device is currently usable.

## Connector and plugin icon behavior (current Claude limitation)

KMJ CodeBridge ships exactly one locked icon (`assets/icon.png`, alongside
`assets/logo.png`) from `plugin/assets/`, copied byte-for-byte into every
generated client package by `scripts/package-common.js`. What each Claude
surface actually _displays_ for that asset is governed by Anthropic's own
client code, not by anything this repository can override, so this section
records current, confirmed behavior rather than assuming a fix is possible.

**Claude Code plugins.** `claude-plugin/.claude-plugin/plugin.json` sets
`icon: "./assets/icon.png"`. Per the
[plugin manifest reference](https://code.claude.com/docs/en/plugins-reference#directory-listing-fields),
this field is read only for the plugin's listing in Anthropic's own plugin
directory, if and when it is submitted there — "Claude Code doesn't read
it" at load time. There is currently no supported way to make Claude
Code's own `/plugin` panel or plugin list show a custom icon; it falls
back to a letter monogram or generic icon regardless of what a plugin
ships.

**Claude.ai / Claude Desktop custom connectors.** These do not reliably
read MCP `serverInfo`/`Implementation.icons` from the `initialize`
handshake — a confirmed, open gap with no ETA as of this writing
([anthropics/claude-ai-mcp#152](https://github.com/anthropics/claude-ai-mcp/issues/152),
[anthropics/claude-code#95558](https://github.com/anthropics/claude-code/issues/95558)).
Instead, Claude.ai can fall back to a favicon lookup against the **root
domain (eTLD+1) of the connector's URL** through Google's favicon service,
ignoring `/favicon.ico`, `serverInfo.icons` and OAuth `logo_uri` alike.

**What this means for a "wrong icon" report.** This repository commits no
hosted gateway domain — every doc here uses `YOUR-ACTUAL-HOST` because
operators self-host. So the icon Claude.ai shows for a custom-connector
add is strongly influenced by whatever favicon is served at the root
domain the operator points Claude at, which this repository cannot
control. If a gateway is reverse-proxied under the same root domain as
another site (for example the KMJ Main Platform), and that site's own
favicon is still a generic/default one, Claude.ai's lookup can surface
that icon — not anything CodeBridge configures. The Main Platform's own
favicon is out of scope for this phase of work and will be addressed
separately.

**Standards-compliant forward path.** The gateway can still advertise a
spec-compliant `Implementation.icons` entry (MCP spec 2025-11-25 /
SEP-973) in its `initialize` response, for every MCP client that already
honors it (several do; Claude's support is unreliable today). Set the
gateway's optional `iconUrl` config field to a real, publicly reachable
HTTPS icon URL to enable this — the gateway never fabricates or guesses a
URL, so the field is simply omitted from `serverInfo` when `iconUrl` is
unset.

## ChatGPT

The OpenAI package is generated from the same canonical plugin source:

```sh
npm run package:plugin -- https://kmjtechno.com/mcp
```

The package contains the MCP resource URL and no user credential. Directory
review/approval remains an external publishing step and must not be confused
with a working private/developer connection.

## Generic clients

Generate credential-free templates with:

```sh
npm run client:config -- https://kmjtechno.com/mcp
npm run client:config -- https://kmjtechno.com/mcp --format mcp-json
npm run client:config -- https://kmjtechno.com/mcp --format claude-json
```

A new client that supports Streamable HTTP and the configured OAuth flow should
not require a second filesystem, policy, licensing, or device implementation.

## Publishing

Anthropic and OpenAI public directory listings are reviewed by those platforms.
Repository packaging, local validation, and a successful private connection do
not imply approval, ranking, or publication.
