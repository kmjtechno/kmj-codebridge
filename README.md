<p align="center"><img src="plugin/assets/logo.png" alt="KMJ TECHNO" width="220"></p>

# KMJ CodeBridge

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Connect your systems. Build with AI.**

KMJ CodeBridge is a secure, vendor-neutral MCP coding bridge for controlled
AI-assisted development across authorized computers and VPSs. ChatGPT, Claude.ai,
Claude Desktop, Claude Code and other MCP clients use the same gateway, tools and
security controls. Commercial licensing belongs to **KMJ Main Platform**.

## Status: executable developer preview, not production GA

This repository includes a real Streamable HTTP MCP gateway using the official
SDK, an outbound-polling device agent, scoped file operations, administrator-defined
quality gates, durable job results and an Ed25519 entitlement verifier. The tests
exercise a real MCP client, gateway and agent over loopback HTTP.

**Not yet delivered:** public hosted endpoint, live OAuth account linking, live Main
Platform billing/renewal adapter, native Rust agent, signed OS installers, public
plugin or connector approval (OpenAI or Anthropic), SSO, or a production security
certification. A source upload is not a connected ChatGPT or Claude installation.
See [status](docs/STATUS.md).

## Supported AI clients

| Client         | How it connects                                          | Current state                                      |
| -------------- | -------------------------------------------------------- | -------------------------------------------------- |
| ChatGPT        | Plugin package + remote MCP                              | Package tested; live connection needs hosted OAuth |
| Claude Code    | `claude plugin marketplace add kmjtechno/kmj-codebridge` | Plugin validated by `claude plugin validate` in CI |
| Claude Desktop | Custom connector to a public HTTPS `/mcp` URL            | Documented; needs hosted endpoint and OAuth        |
| Claude.ai      | Custom connector to a public HTTPS `/mcp` URL            | Documented; not available until hosting and OAuth  |
| Other MCP      | Streamable HTTP with bearer or MCP OAuth                 | Covered by the vendor-neutral interop contract     |

All clients share one tool contract, one skill and one security model. Setup,
prerequisites and limits for each client are in [AI client support](docs/CLIENTS.md).

## One-command VPS install

The Linux installer now implements the client side of secure zero-manual-token
enrollment. From an authorized project directory, the target customer flow is:

```sh
curl -fsSL https://OFFICIAL-CODEBRIDGE-DOMAIN/install | sudo bash
```

It detects x64/arm64, verifies or installs Node.js 24 from official checksum data,
stages the CodeBridge runtime, detects common fixed quality gates, requests a
short-lived verifier-bound device enrollment, prints only an HTTPS approval URL and
human pairing code, securely stores the approved independent device credential,
installs a hardened boot-enabled systemd service, starts it, and verifies gateway
metadata connectivity. The agent remains outbound-only: no inbound VPS port and no
GitHub Actions self-hosted runner are required.

Re-running the installer preserves a valid existing device configuration and performs
an update/repair. Runtime/config backups are retained until the replacement service
and gateway checks pass; failure rolls back automatically.

**Production blocker:** KMJ Main Platform must implement the versioned enrollment,
approval and redemption endpoints in [the enrollment contract](docs/ENROLLMENT.md).
Until those live endpoints exist, a completely fresh production VPS will fail
enrollment rather than fabricate a credential. Existing enrolled installations can
still use the idempotent update/repair path.

The installer auto-detects useful fixed gates when present: npm
`test/check/lint/build`, Laravel tests, Composer tests, Cargo tests, Go tests and
pytest. It does not expose arbitrary shell execution.

## Quick start

Requires Node.js 24 and npm. Use a disposable development project initially.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run scan:secrets
npm run init -- /absolute/private-codebridge-config /absolute/development-project
npm run gateway -- /absolute/private-codebridge-config/gateway.json
```

In a second terminal:

```sh
npm run agent -- /absolute/private-codebridge-config/agent.json
```

The configuration directory must be outside the project. Initial access is read-only.
The initializer generates credentials, stores only hashes at the gateway and writes
no credentials to terminal output. Never commit or paste the generated files in chat.
On Windows, use absolute Windows paths and restrict configuration ACLs to the service
account. Unix configuration mode must be `0600`.

A compatible MCP client can connect to `http://127.0.0.1:8787/mcp` using the bearer
credential from `client-token.txt`, for example Claude Code (see
[AI client support](docs/CLIENTS.md#claude-code)). That is a local developer
connection, not a public ChatGPT or Claude endpoint. For remote connections, configure TLS and the approved hostname;
plain HTTP agents are limited to loopback. See [deployment](docs/DEPLOYMENT.md).

To enable editing, set the chosen project's `writable` to `true` in the private agent
configuration. Add explicitly approved commands under `gates`, for example:

```json
{
  "unit": { "command": "/usr/bin/node", "args": ["--test"], "timeoutMs": 30000 }
}
```

Use the actual absolute executable path on your machine. No shell is used. A gate
runs real project code and is not a sandbox; run untrusted code in a separately
isolated VM/container without host credentials.

## Tools

| Tool                                                 | Behavior                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `list_devices`                                       | Devices and projects allowed for the authenticated tenant   |
| `inspect_project`, `connection_doctor`               | Capabilities and connection information                     |
| `git_status`                                         | Bounded Git status with fsmonitor disabled                  |
| `list_directory`, `read_file`, `search_code`         | Bounded project navigation, UTF-8 reads and literal search  |
| `edit_file`                                          | Exact unique-fragment edit with SHA-256 conflict protection |
| `preview_file`, `write_file`                         | Expected-hash guarded replacements; no blind overwrite      |
| `run_quality_gate`                                   | Fixed administrator-configured command and arguments        |
| `get_job_status`, `cancel_job`                       | Recorded state, output, exit code and process cancellation  |
| `github_repository`, `github_pull_request*`          | Server-side GitHub repository and PR inspection             |
| `github_actions_*`                                   | Bounded/redacted GitHub Actions status, jobs and logs       |
| `github_create_branch`, `github_create_pull_request` | Allowlisted GitHub write operations via server credential   |

The gateway routes to devices that poll outbound; it cannot independently read their
files. Authorization is enforced at both the gateway and the agent. Devices do not
need an inbound port. File writes use bounded synchronous precondition checks and
atomic replacement; this is not a kernel security boundary against a malicious
local process racing the agent.

## Licensing and packaging

The preview has an explicit Free mode limited to one configured project and one
concurrent job. Signed mode verifies an administrator-installed entitlement bound
to the tenant and device. It does not manufacture trials or call a pretend billing
endpoint. See [licensing contract](docs/LICENSING.md).

The source plugin contains no fabricated MCP URL. Once a real approved HTTPS endpoint
with compatible authentication is available:

```sh
npm run package:plugin -- https://YOUR-ACTUAL-HOST/mcp   # ChatGPT / OpenAI package
npm run package:claude -- https://YOUR-ACTUAL-HOST/mcp   # Claude Code plugin + marketplace
```

Both build from the same `plugin/` metadata and skill and write only to `dist/` (or
an empty `--out` directory). They do not publish anything, add OAuth or check that
the endpoint is reachable. `npm run package:claude -- URL --auth bearer-env` makes
Claude Code read the bearer credential from `KMJ_CODEBRIDGE_TOKEN`; no credential is
ever written into a package. The bearer-auth developer preview requires a client
capable of supplying a header; production OAuth account linking for ChatGPT and
Claude is an outstanding integration gate.

## Documentation

- [AI client support: ChatGPT, Claude Code, Claude Desktop, Claude.ai](docs/CLIENTS.md)
- [Full YAML roadmap](docs/specs/KMJ-CodeBridge-Roadmap.yaml)
- [Implementation plan](docs/superpowers/plans/2026-09-29-codebridge.md)
- [Security boundaries](SECURITY.md)
- [Deployment and operations](docs/DEPLOYMENT.md)
- [Secure device enrollment contract](docs/ENROLLMENT.md)
- [Server-side GitHub bridge](docs/GITHUB.md)
- [Main Platform entitlement contract](docs/LICENSING.md)
- [Current delivery status](docs/STATUS.md)
- [Contributing](CONTRIBUTING.md)
- [Apache License 2.0](LICENSE)

If this project is useful, star the repository and share a reproducible feature
request. Please do not post credentials, source-code secrets or customer data in issues.

## License

Copyright 2026 KMJ TECHNO.

KMJ CodeBridge is open-source software licensed under the [Apache License 2.0](LICENSE).
The license permits use, modification and distribution subject to its terms. The
Apache License does not grant permission to use KMJ TECHNO trade names, trademarks,
service marks or product names except as allowed by the license.
