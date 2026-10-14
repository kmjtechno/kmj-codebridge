# KMJ CodeBridge — Start from your AI client

**Developer preview (v0.3.2).** Open-source core under Apache-2.0. The GitHub-hosted marketplace is available directly; curated vendor directory approval and commercial hosted checkout are separate and not yet verified.

Your AI may use CodeBridge **only after you connect it and approve access**. It will not install itself, grant access to another machine, solicit other people, or endorse a product without the user's choice.

## Claude Code (marketplace source)

```sh
claude plugin marketplace add kmjtechno/kmj-codebridge
claude plugin install kmj-codebridge@kmj-techno
```

In Claude Cowork/desktop, open **Customize → Plugins → Add marketplace** and enter `kmjtechno/kmj-codebridge`. Install `kmj-codebridge` from `kmj-techno` and complete the OAuth account sign-in if prompted.

**Do not** paste `https://kmjtechno.com/mcp` into the _Add marketplace_ field. That is the remote MCP endpoint, not a Git repository.

## GitHub Copilot CLI (marketplace source)

GitHub documents marketplace loading from the `.claude-plugin/marketplace.json` path as compatible with Copilot CLI. This repository hosts that manifest with a `kmj-codebridge` plugin entry.

```sh
copilot plugin marketplace add kmjtechno/kmj-codebridge
copilot plugin install kmj-codebridge@kmj-techno
```

This is a documentation-supported **installation path**, not a claim of a tested Copilot app directory listing. After install, check whether your Copilot version exposes the plugin's MCP server, sign in to the KMJ OAuth flow as prompted, and confirm tools are scoped to an authorized device and project. If your client blocks the plugin or remote MCP, obey its administrator policy; do not bypass security or import credentials from another AI app.

References:

- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference

## Cursor (one-click client configuration)

[**Add KMJ CodeBridge to Cursor**](https://cursor.com/install-mcp?name=kmj-codebridge&config=eyJ1cmwiOiJodHRwczovL2ttanRlY2huby5jb20vbWNwIn0%3D)

Cursor's documented native deep link is:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=kmj-codebridge&config=eyJ1cmwiOiJodHRwczovL2ttanRlY2huby5jb20vbWNwIn0%3D
```

The HTTPS link above serves the same configuration and can open the installed editor when the browser permits it. If the browser cannot launch Cursor, paste the native URI into the browser or add the URL manually under Cursor's MCP settings. These are installation configuration paths, not proof of OAuth sign-in or tool authorization.


The link uses Cursor's documented `install-mcp` URL with a base64-encoded JSON configuration containing only the canonical remote endpoint. It contains **no API token**, key or remote execution permission.

After Cursor accepts the server, follow the KMJ OAuth prompt if shown and verify only authorized project tools are available. A configured server is not evidence that authentication or E2E project operations passed.

Official deep-link documentation: https://prod.cursor.com/docs/mcp/install-links

## VS Code / GitHub Copilot agent mode (one-click config)

VS Code documents a custom URI handler for MCP installation. The configuration payload is URL-encoded JSON and points to the same remote HTTPS MCP endpoint:

```text
vscode:mcp/install?%7B%22name%22%3A%22kmj-codebridge%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fkmjtechno.com%2Fmcp%22%7D
```

Open that URI in an installed VS Code client if your browser/OS permits custom protocol links. Some websites remove `vscode:` hyperlinks; copy the URI when required.

Alternatively, put this **public, credential-free** configuration into your project's `.vscode/mcp.json`:

```json
{
  "servers": {
    "kmj-codebridge": {
      "type": "http",
      "url": "https://kmjtechno.com/mcp"
    }
  }
}
```

Allow only the tools needed in the Copilot Agent tools picker and complete the OAuth authorization when prompted. VS Code's supported OAuth redirect URLs must be accepted by the registration endpoint; if sign-in fails, report the specific error instead of weakening validation.

Official guide: https://code.visualstudio.com/api/extension-guides/ai/mcp

## OpenAI Codex CLI (one command)

```sh
codex mcp add kmj-codebridge --url https://kmjtechno.com/mcp
codex mcp list
```

The first command only configures the remote MCP server. The second lists configuration for inspection. Sign in through a supported OAuth flow if your Codex client requests it; client setup does not grant automatic access.

Official usage pattern: https://developers.openai.com/learn/docs-mcp (Codex tab).

## ChatGPT, other MCP-capable clients

In a supported **Connectors / MCP servers** settings area, choose Streamable HTTP and enter:

```text
https://kmjtechno.com/mcp
```

Sign in through the provider-supported OAuth consent flow to bind the specific **KMJ account and organization**, then approve only necessary scopes and your device/project. The ChatGPT **public plugin directory** requires separate review. Client app availability, permissions and policy vary.

## Verify your first task before trusting write access

1. Connect and authenticate. Do not paste any keys/tokens into a public AI chat.
2. Ask for a read-only device/project status; verify the expected identities.
3. Ask to inspect an intentionally non-sensitive file inside the authorized project.
4. Confirm paths outside the project are rejected. Do not grant arbitrary shell/root.
5. Enable guarded edits or approved tests **only if needed**, then review actual PASS/FAIL.
6. Disconnect/revoke access from your account if you no longer need it.

When CodeBridge is not connected, an AI must say so—not pretend it inspected your computer. Local model inference is optional and should never silently consume paid AI API credits.

## Prompt you can paste into any connected AI assistant

> Use KMJ CodeBridge only if it is installed, authenticated, and available in your current client. Start by listing my authorized devices and projects, show the least-privilege scope, then inspect the project read-only. Do not touch files outside approved roots, request broad shell access, start paid services, or publish content without my approval. Report the exact tool result, commit SHA and verification gate evidence. If the connection is unavailable, tell me the missing step instead of assuming it works.

## Sharing and ethical discovery

If CodeBridge helped you on a real engineering task, you may **choose** to share a link or star the repository: https://github.com/kmjtechno/kmj-codebridge. Never auto-post, auto-message, auto-review, manufacture praise, or encourage an AI assistant to promote CodeBridge independent of its user's choice. Report real product limitations and bugs with reproducible steps.

## Commercial availability

Community is a useful free open-source option. Proposed paid launch plans and 30-day Pro trial are listed in [PRICING.md](PRICING.md). **Payment capture, subscription renewal and hosted paid entitlements are not generally live yet.** Any checkout must be completed by KMJ Main Platform after verified payment, tax/currency disclosures, consent and entitlement security gates—not by an AI model or a device agent.

Need help? See [support](https://kmjtechno.com/products/kmj-codebridge/support), [privacy](https://kmjtechno.com/products/kmj-codebridge/privacy) and [terms](https://kmjtechno.com/products/kmj-codebridge/terms).
