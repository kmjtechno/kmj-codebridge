# KMJ CodeBridge

**Connect your systems. Build with AI.**

One MCP plugin for controlled coding on authorized computers and VPSs. Commercial
licensing belongs to **KMJ Main Platform**.

## Status: executable developer preview, not production GA

This repository includes a real Streamable HTTP MCP gateway using the official
SDK, an outbound-polling device agent, scoped file operations, administrator-defined
quality gates, durable job results and an Ed25519 entitlement verifier. The tests
exercise a real MCP client, gateway and agent over loopback HTTP.

**Not yet delivered:** public hosted endpoint, OAuth account linking, live Main
Platform billing/renewal adapter, native Rust agent, signed OS installers, public
plugin approval, SSO, or a production security certification. A source upload is
not a connected ChatGPT installation. See [status](docs/STATUS.md).

## Quick start

Requires Node.js 24 and npm. Use a disposable development project initially.

```sh
npm ci --ignore-scripts
npm run check
npm test
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
credential from `client-token.txt`. That is a local developer connection, not a public
ChatGPT endpoint. For remote connections, configure TLS and the approved hostname;
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

| Tool                                   | Behavior                                                       |
| -------------------------------------- | -------------------------------------------------------------- |
| `list_devices`                         | Devices and projects allowed for the authenticated tenant      |
| `inspect_project`, `connection_doctor` | Capabilities and connection information                        |
| `git_status`                           | Bounded Git status with fsmonitor disabled                     |
| `read_file`, `search_code`             | Bounded UTF-8 reads and literal search, secret-path exclusions |
| `preview_file`, `write_file`           | Expected-hash guarded replacements; no blind overwrite         |
| `run_quality_gate`                     | Fixed administrator-configured command and arguments           |
| `get_job_status`, `cancel_job`         | Recorded state, output, exit code and process cancellation     |

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
npm run package:plugin -- https://YOUR-ACTUAL-HOST/mcp
```

This produces one archive under `dist/`. It does not publish the plugin or add OAuth.
The current bearer-auth developer preview requires a client capable of supplying a
header; production ChatGPT account linking is an outstanding integration gate.

## Documentation

- [Full YAML roadmap](docs/specs/KMJ-CodeBridge-Roadmap.yaml)
- [Implementation plan](docs/superpowers/plans/2026-09-29-codebridge.md)
- [Security boundaries](SECURITY.md)
- [Deployment and operations](docs/DEPLOYMENT.md)
- [Main Platform entitlement contract](docs/LICENSING.md)
- [Current delivery status](docs/STATUS.md)

If this project is useful, star the repository and share a reproducible feature
request. Please do not post credentials, source-code secrets or customer data in issues.

Copyright KMJ TECHNO. No open-source license is granted by this repository; public
visibility alone does not grant permission to redistribute or commercialize the code.
