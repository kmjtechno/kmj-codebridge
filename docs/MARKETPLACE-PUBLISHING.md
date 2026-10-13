# KMJ CodeBridge — marketplace publication matrix (October 2026)

KMJ CodeBridge is an owner-scoped OAuth MCP service, not a free anonymous
coding/shell endpoint. The official remote URL is
`https://kmjtechno.com/mcp`. Never embed API keys or personal
credentials in a public marketplace description, plugin ZIP, manifest,
reviewer screenshot or repository.

## A. Self-hosted Claude plugin marketplace — repository AVAILABLE

This repository already contains:
- `.claude-plugin/marketplace.json`
- `claude-plugin/.claude-plugin/plugin.json`
- `claude-plugin/.mcp.json`
- the CodeBridge skill, license, and canonical assets.

**Claude Cowork/Claude app → Customize → Plugins → Add → Add marketplace:**
enter **`https://github.com/kmjtechno/kmj-codebridge`** or
`kmjtechno/kmj-codebridge`. The `Add marketplace` field accepts a Git
repository, **not** the `/mcp` server endpoint. Select/install the
`kmj-codebridge` entry from the `kmj-techno` marketplace.

**Claude Code CLI:**
```sh
claude plugin marketplace add kmjtechno/kmj-codebridge
claude plugin install kmj-codebridge@kmj-techno
```

**Remote connector path** (Claude Web / Desktop / third-party inference
Gateway): put `https://kmjtechno.com/mcp` under Connectors / Managed MCP
servers with Streamable HTTP and OAuth; never under Add Marketplace.

If your organization disallows external Git repositories or network egress,
an owner must approve GitHub access. The product cannot bypass organizational
egress policy. An existing locally extracted plugin ZIP offers an alternative
Claude Code marketplace source if local directories are allowed.

**Publication state**: GitHub-hosted marketplace files available; NOT
equivalent to approval/listing in Anthropic's curated Claude directory.

## B. Official MCP Registry — READY FOR OWNER-GATED OIDC PUBLISH

- `server.json` declares a **remote** (not npm) Streamable HTTP server,
  `io.github.kmjtechno/kmj-codebridge`, at the canonical MCP endpoint.
- Does not claim `@kmjtechno/codebridge` has been published to npm:
  the repository's `package.json` currently has `private: true`.
- To publish, verify hosted OAuth/MCP live smoke (challenge, sign-in,
  tools/list, scoped authorized test call and denied out-of-scope call),
  then configure GitHub Environment `mcp-registry-publish` with required
  reviewer approval and branch `main` restriction. Review any branch
  protection and other release gates.
- GitHub Actions → **Publish KMJ CodeBridge to official MCP Registry**
  → Run workflow on `main`, input `PUBLISH_KMJ_CODEBRIDGE`.
- The manual job validates the manifest, fetches a pinned official
  `mcp-publisher`, authenticates via GitHub OIDC and attempts publication.
  No registry-specific static API key is added to GitHub.
- A successful job and a real public registry search result are required
  before marking `PUBLISHED`.

GitHub OIDC is scoped to the GitHub namespace owner. Organization ownership
or identity attestation may still block the first publication. If this
fails, do NOT invent a token or change names to impersonate another owner.

Official references:
https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/remote-servers.mdx
https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx

## C. Anthropic Claude curated plugin directory — REVIEW REQUIRED

Visit https://claude.com/marketplace/plugins and choose **Submit a plugin**,
using the GitHub plugin-bundle submission path. Enter the GitHub repository,
README, KMJ branding, terms/privacy/support links, and a reviewer-safe
OAuth test account. Anthropic's developer submission portal is a separate
review process and may require a paid Claude plan. Nothing in GitHub can
grant Anthropic directory approval or avoid the portal's review.

## D. OpenAI public plugin directory — SEPARATE REVIEW REQUIRED

See `docs/OPENAI-SUBMISSION.md` for the verified outstanding steps:
organization/domain verification, live server scan, reviewer sample device
and project, test recordings and submitted owner attestations. Technical
ChatGPT CodeBridge connectivity is NOT the same as public listing approval.
Use the authenticated OpenAI submission portal; do not put review secrets in
Git, GitHub issues, ZIP or chat.

## E. Smithery — PUBLISHER LOGIN REQUIRED

Official CLI: https://github.com/arcadeai-labs/smithery-cli

Authenticate under a KMJ-controlled Smithery account/namespace, inspect
which organization is authorized, then run:

```sh
smithery mcp publish https://kmjtechno.com/mcp -n kmjtechno/kmj-codebridge
```

Remote OAuth access and directory health scanner may require additional
provider-specific test configuration. This command is documentation, not
evidence it has run or been accepted.

## F. Glama — SUBMIT & CLAIM REQUIRED

Use https://glama.ai/mcp/servers → **Add MCP Server**, supplying the
GitHub repository and canonical remote URL. `glama.json` declares
the connected GitHub maintainer account; Glama requires a GitHub
claim/verification to associate an organization-hosted repository.
Run its health/security validation and confirm discoverability.

## G. Other catalogs (MCP.so, PulseMCP, clients)

Independent catalogs and third-party IDE directories have their own
submission, verification, policies and review. Do not mass-post fake
entries, claim that registry indexing guarantees per-client support or
spam repeated submissions. Official MCP Registry inclusion may feed
compatible directories automatically, but indexing is not guaranteed.
The public repository and a consent-based owner submission is preferred.

## Evidence policy

Keep each entry as one of:
`SOURCE_READY`, `SUBMISSION_REQUESTED`, `UNDER_REVIEW`,
`PUBLISHED_VERIFIED` or `BLOCKED_AUTHORIZATION`.

Only `PUBLISHED_VERIFIED` means an external directory has actually
accepted and publicly indexed CodeBridge. Neither CI PASS nor a working
local ZIP is sufficient proof. Never turn on unexpected paid subscriptions.
