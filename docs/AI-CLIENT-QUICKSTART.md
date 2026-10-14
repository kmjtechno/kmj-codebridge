# KMJ CodeBridge — Start from your AI client

**Developer preview (v0.3.2).** Open-source core under Apache-2.0. The GitHub-hosted marketplace is available directly; curated vendor directory approval and commercial hosted checkout are separate and not yet verified.

Your AI may use CodeBridge **only after you connect it and approve access**. It will not install itself, grant access to another machine, solicit other people, or endorse a product without the user's choice.

## Claude Code (marketplace source)

```sh
claude plugin marketplace add kmjtechno/kmj-codebridge
claude plugin install kmj-codebridge@kmj-techno
```

In Claude Cowork/desktop, open **Customize → Plugins → Add marketplace** and enter `kmjtechno/kmj-codebridge`. Install `kmj-codebridge` from `kmj-techno` and complete the OAuth account sign-in if prompted.

**Do not** paste `https://kmjtechno.com/mcp` into the *Add marketplace* field. That is the remote MCP endpoint, not a Git repository.

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
