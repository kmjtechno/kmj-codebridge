# AI client support

KMJ CodeBridge is a vendor-neutral Model Context Protocol (MCP) server. Every
supported AI client connects to the **same** gateway, sees the **same** tool
definitions and is subject to the **same** authentication, authorization,
licensing, policy and audit controls. There is no separate OpenAI or Claude
execution path.

```text
ChatGPT ─────────┐
Claude.ai ───────┤
Claude Desktop ──┼──► CodeBridge MCP gateway (/mcp, Streamable HTTP)
Claude Code ─────┤        │  authentication · authorization · licensing
Future MCP client┘        │  policy · rate limits · audit/evidence
                          ▼
                   CodeBridge device agent (outbound polling)
                          ▼
                   Authorized computer / VPS project
```

## Support status (developer preview)

| Client         | Integration artifact                                 | Status in this repository                                                                  |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ChatGPT        | `plugin/` package via `npm run package:plugin`       | Package contract tested; live ChatGPT connection needs a hosted HTTPS endpoint and OAuth   |
| Claude Code    | Plugin + marketplace via `npm run package:claude`    | Package validated with `claude plugin validate --strict`; `claude mcp add` path documented |
| Claude Desktop | Custom connector (Settings, remote MCP URL)          | Documented only; needs the same public HTTPS endpoint and OAuth as Claude.ai               |
| Claude.ai      | Custom connector (remote MCP URL)                    | Documented only; not available until a hosted endpoint and authorization server exist      |
| Other clients  | Any MCP client supporting Streamable HTTP and bearer | Covered by the vendor-neutral interoperability contract (`tests/interop.test.js`)          |

No public hosted endpoint, directory listing, Anthropic or OpenAI approval, or
production availability is claimed. See [status](STATUS.md).

## One contract for every client

- **Tools:** `src/tools.js` is the single definition of tool names, titles,
  descriptions, input schemas and access level. Annotations are derived from the
  access level: read tools are `readOnlyHint`, write/execute tools are
  `destructiveHint`, and only `run_quality_gate` is `openWorldHint`.
- **Instructions:** `plugin/skills/codebridge/SKILL.md` is the single source of
  agent rules. The OpenAI and Claude Code packages copy it byte-for-byte, and
  tests fail if either package drifts.
- **Client-specific metadata:** the OpenAI Apps SDK reads extra `_meta` keys
  (`securitySchemes`, `mcp/www_authenticate`). They live in
  `src/client-extensions.js`, are sent to every client (MCP `_meta` is an open
  extension point that other clients ignore) and never influence authorization.
- **Licensing:** KMJ Main Platform remains the only commercial authority. The
  AI client a user chooses does not change entitlements, and CodeBridge contains
  no Anthropic or OpenAI billing logic.

## Claude Code

Claude Code connects to remote MCP servers over Streamable HTTP
([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)). Use either
option below. Both talk to the same gateway.

### Option A: add the server directly

With an OAuth-enabled gateway (recommended for anything beyond local testing):

```sh
claude mcp add --transport http --scope user kmj-codebridge https://YOUR-ACTUAL-HOST/mcp
```

Then run `/mcp` inside Claude Code and choose the server to sign in. Claude Code
discovers the authorization server from the gateway's protected-resource
metadata.

With a developer-preview gateway that uses a static bearer credential, keep the
credential in your environment instead of on the command line or in a file:

```sh
export KMJ_CODEBRIDGE_TOKEN="$(cat /absolute/private-codebridge-config/client-token.txt)"
claude mcp add-json --scope user kmj-codebridge \
  '{"type":"http","url":"https://YOUR-ACTUAL-HOST/mcp","headers":{"Authorization":"Bearer ${KMJ_CODEBRIDGE_TOKEN}"}}'
```

Claude Code expands `${KMJ_CODEBRIDGE_TOKEN}` when it connects. For a local
loopback gateway (`http://127.0.0.1:8787/mcp`) the same commands work with that
URL.

### Option B: install the CodeBridge plugin

The plugin bundles the canonical skill with the MCP server entry, following the
[plugin](https://code.claude.com/docs/en/plugins-reference) and
[marketplace](https://code.claude.com/docs/en/plugins/marketplace-reference)
references.

```sh
npm run package:claude -- https://YOUR-ACTUAL-HOST/mcp                    # OAuth gateway
npm run package:claude -- https://YOUR-ACTUAL-HOST/mcp --auth bearer-env  # bearer via env
```

This writes a local marketplace to `dist/claude-code/` and an archive to
`dist/kmj-codebridge-claude-code.tar.gz`. Validate and install it:

```sh
claude plugin validate --strict dist/claude-code
claude plugin marketplace add ./dist/claude-code
claude plugin install kmj-codebridge@kmj-techno
```

In `bearer-env` mode the package contains only the `${KMJ_CODEBRIDGE_TOKEN}`
reference; export the variable before starting Claude Code. The package never
contains a credential, and packaging does not check that the endpoint is
reachable.

## Claude.ai and Claude Desktop

Claude.ai, Claude Desktop and Claude mobile connect to remote MCP servers as
**custom connectors** added by URL. Requests come from Anthropic's cloud, not
from the user's computer, so the gateway must be publicly reachable over HTTPS.
A loopback or private-network gateway cannot be used.

Prerequisites, from Anthropic's
[connector authentication requirements](https://claude.com/docs/connectors/building/authentication):

1. A hosted gateway at a stable public `https://…/mcp` URL (`npm start` hosted
   mode, which requires `oauth` and a matching `allowedHosts` entry).
2. An OAuth 2.x authorization server that supports PKCE S256
   (`code_challenge_methods_supported: ["S256"]`) and Dynamic Client
   Registration or Client ID Metadata Documents.
3. Registered redirect URIs: `https://claude.ai/api/mcp/auth_callback` for the
   hosted Claude apps, plus port-agnostic loopback redirects
   (`http://localhost/callback`, `http://127.0.0.1/callback`) for Claude Code.
4. Access tokens whose audience is exactly the gateway's `oauth.resource` URL,
   carrying `codebridge:read`, `codebridge:write` and/or `codebridge:execute`.
5. Firewall/WAF rules that admit Anthropic's published egress range
   (`160.79.104.0/21` at the time of writing) to the gateway and the
   authorization server's discovery, registration and token endpoints.

The gateway already implements the resource-server side that Claude requires:
a `401` with `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`,
RFC 9728 metadata at both `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`, one authorization server listed
first, and `resource` equal to the configured MCP URL. Requests from
Anthropic's servers carry no browser `Origin`, so the existing origin allowlist
is unaffected.

Once those prerequisites exist, a user adds the connector in Claude under
**Settings → Connectors → Add custom connector** with the gateway URL. Until
then, Claude.ai and Claude Desktop support is **not available**; do not publish
setup instructions to customers.

Claude Desktop's local `claude_desktop_config.json` launches local stdio
servers. CodeBridge is a remote HTTP server, so Desktop uses the custom
connector path above rather than that file.

## ChatGPT

Unchanged. See the README "Licensing and packaging" section and
[OAuth configuration](OAUTH.md). `npm run package:plugin` produces the same
package layout as before, now from shared packaging code.

## Adding another MCP client

A client that supports MCP Streamable HTTP and either bearer headers or MCP
OAuth needs no gateway, agent, policy, licensing or audit changes. Add a
packaging script only if the client has its own plugin format, reuse
`scripts/package-common.js`, copy the canonical skill, and add a package
contract test beside `tests/client-packages.test.js`.
