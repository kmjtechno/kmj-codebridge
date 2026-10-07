<p align="center">
  <img src="plugin/assets/logo.png" alt="KMJ TECHNO" width="210">
</p>

<p align="center">
  <img src="docs/assets/codebridge-cinematic-hero-final.jpg" alt="KMJ CodeBridge — Connect your systems. Build with AI." width="100%">
</p>

<h1 align="center">KMJ CodeBridge</h1>

<p align="center">
  <strong>Secure AI-to-Development Infrastructure for Authorized Systems</strong>
</p>

<p align="center">
  Connect ChatGPT, Claude, and compatible MCP clients to approved projects across laptops, workstations, and VPS infrastructure—through scoped access, policy-controlled actions, and verifiable engineering workflows.
</p>

<p align="center">
  <strong
    >Vendor-neutral MCP · Outbound device agents · Guarded writes · Controlled quality gates</strong
  >
</p>

<p align="center">
  Built by <strong>KMJ TECHNO</strong><br>
  Founded and led by <strong>Narendra Singh Kushwah · Founder & CTO</strong>
</p>

<p align="center">
  <a href="https://github.com/KMJ-TECHNO"><strong>Official KMJ TECHNO GitHub Organization</strong></a>
</p>

<p align="center">
  <a href="https://github.com/kmjtechno/kmj-codebridge/actions/workflows/ci.yml"><img alt="CodeBridge CI" src="https://github.com/kmjtechno/kmj-codebridge/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/kmjtechno/kmj-codebridge/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/kmjtechno/kmj-codebridge?style=flat&color=ED010B"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-ED010B"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/Node-24%2B-111111">
  <img alt="MCP" src="https://img.shields.io/badge/protocol-MCP-111111">
  <img alt="Developer Preview" src="https://img.shields.io/badge/status-developer%20preview-ED010B">
</p>

<p align="center">
  <a href="#why-codebridge"><strong>Why CodeBridge?</strong></a> ·
  <a href="#architecture"><strong>Architecture</strong></a> ·
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="#security-boundaries"><strong>Security</strong></a> ·
  <a href="#contributing"><strong>Contributing</strong></a>
</p>

---

## Why CodeBridge?

AI coding gets powerful when it can inspect the real project, make a precise edit and prove the result with a real quality gate. It also gets dangerous when the only answer is “give the model a shell”.

CodeBridge takes a narrower approach:

- **One bridge for multiple MCP clients** — ChatGPT, Claude and compatible clients can share the same tool contract.
- **Outbound-only device agents** — your VPS does not need a public inbound CodeBridge port.
- **Explicit project scope** — the agent works only inside administrator-approved project roots.
- **Guarded writes** — hash/precondition checks reduce blind overwrite risk.
- **Fixed quality gates** — run administrator-approved checks instead of exposing arbitrary shell execution.
- **Tenant + permission enforcement** — authorization is checked at the gateway and device layer.
- **Open-source core** — Apache-2.0 source you can inspect, self-host and contribute to.

## Architecture

CodeBridge separates the AI client, control plane, and device execution boundary instead of treating them as one unrestricted environment.

```text
┌─────────────────────────────┐
│ AI client                   │
│ ChatGPT · Claude · MCP app  │
└──────────────┬──────────────┘
               │ MCP request
               ▼
┌─────────────────────────────┐
│ CodeBridge gateway          │
│ auth · policy · job state   │
└──────────────┬──────────────┘
               │ authorized work item
               ▼
┌─────────────────────────────┐
│ Outbound device agent       │
│ approved device + projects  │
└──────────────┬──────────────┘
               │
               ▼
      inspect → edit → test
               │
               ▼
        bounded result
```

### Trust boundaries

- **The AI client does not receive a generic shell.**
- **The gateway cannot independently browse the device filesystem.**
- **The device agent initiates outbound connectivity.**
- **Project roots are explicitly configured by an administrator.**
- **Writes and quality gates are constrained by policy and preconditions.**
- **Results returned to the AI are bounded and may be redacted.**

The device agent must be online, authorized for the tenant, and configured for the requested project before work can execute.

## What CodeBridge is — and is not

| CodeBridge is                                            | CodeBridge is not                                  |
| -------------------------------------------------------- | -------------------------------------------------- |
| A scoped MCP bridge for authorized development projects  | A general-purpose remote shell                     |
| A policy-controlled path for inspect/edit/test workflows | A way to bypass OS, tenant, or project permissions |
| A device-agent model designed for outbound connectivity  | An inbound SSH replacement                         |
| A framework for bounded, verifiable engineering actions  | A promise that arbitrary code is safe to execute   |

## What you can do

| Tool family                                          | Examples                                                   | Safety boundary                                      |
| ---------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| Discover                                             | `list_devices`, `inspect_project`, `connection_doctor`     | Tenant/project scoped                                |
| Read                                                 | `read_file`, `list_directory`, `search_code`, `git_status` | Bounded output + project root                        |
| Edit                                                 | `edit_file`, `write_file`, `preview_file`                  | Expected-hash / exact-fragment checks                |
| Verify                                               | `run_quality_gate`                                         | Only administrator-configured executable + arguments |
| Structured workflows                                 | `run_project_command`, command presets                     | Fixed admin-approved profiles; no generic shell      |
| Repository intelligence                              | `repo_intelligence`, `context_pack`, fast read batching    | Bounded local metadata/context; no hosted-AI upload  |
| Workflow guidance                                    | `skill_recommendations`, mission/autopilot tools           | Deterministic bounded workflow metadata/state        |
| Jobs                                                 | `get_job_status`, `cancel_job`                             | Durable bounded job state                            |
| `github_repository`, `github_pull_request*`          | Server-side GitHub repository and PR inspection            |
| `github_actions_*`                                   | Bounded/redacted GitHub Actions runs, jobs and logs        |
| `github_create_branch`, `github_create_pull_request` | Allowlisted GitHub write operations via server credential  |

No generic “run any shell command” MCP tool is exposed.

## Check connections without reconnecting

For a new or offline device, ask ChatGPT or Claude: **"KMJ CodeBridge, check my connections and tell me what to fix."**

The read-only `connection_overview` tool shows whether the problem is in the account grant, gateway registration, project scope or agent heartbeat. It does not touch existing projects or require repeated OAuth sign-in. For an offline Main Platform testing VM, use the [single-command Connection Doctor](docs/CONNECTION-DOCTOR.md) to inspect its identity and gateway acceptance without restarting the agent.

## Quick start

> **Use a disposable or non-production project first.** Start read-only, verify the boundary, then enable writes only where you explicitly intend to.

### 1. Prerequisites

- Node.js 24+
- npm
- Git

### 2. Clone and verify

```bash
git clone https://github.com/kmjtechno/kmj-codebridge.git
cd kmj-codebridge

npm ci --ignore-scripts
npm run check
npm test
npm run scan:secrets
```

### 3. Create private configuration outside the repository

```bash
npm run init -- /absolute/private-codebridge-config /absolute/development-project
```

Do not place generated credentials or private configuration inside the Git repository.

### 4. Start the gateway

```bash
npm run gateway -- /absolute/private-codebridge-config/gateway.json
```

### 5. Start the device agent

In another terminal:

```bash
npm run agent -- /absolute/private-codebridge-config/agent.json
```

### 6. Connect an MCP client

Start with read-only tools such as project inspection, directory listing, code search, and Git status. Enable writes only after you have confirmed the intended project scope and device identity.

See **[AI client setup](docs/CLIENTS.md)** for ChatGPT, Claude Code, Claude Desktop, Claude.ai and generic MCP clients.

## One-command VPS enrollment

The target production flow is:

```bash
curl -fsSL https://kmjtechno.com/install | sudo bash
```

The installer is designed to detect architecture, stage the runtime, enroll the device, install a hardened systemd service and verify gateway connectivity without installing a GitHub self-hosted runner. The Main Platform bootstrap now pins the CodeBridge setup helper to an immutable 40-hex revision, downloads it over HTTPS/TLS, verifies its exact SHA-256 before execution, preserves an existing enrollment, and uses a read-only repository deploy key. It does not pass an agent token on the command line.

Already-enrolled Main Platform agents can be refreshed through a fixed Supervisor operation that accepts no repository, path, service name, command, or credential input and refuses to create a new enrollment.

**Current production gate:** deterministic bootstrap/repair and existing-enrollment refresh behavior are verified in CI and the live account currently reports both authorized projects READY. A recorded end-to-end run on a disposable fresh device is still required before claiming fresh-device production proof. See [enrollment contract](docs/ENROLLMENT.md) and [current status](docs/STATUS.md).

## Free forever + ultra-low-cost launch plans

The open-source Community tier stays useful. Hosted convenience and higher commercial limits are paid entitlements through **KMJ Main Platform**.

| Plan            |                                    Launch price | Best for                                  |
| --------------- | ----------------------------------------------: | ----------------------------------------- |
| **Community**   |                                        **Free** | OSS users, evaluation, one device/project |
| **Pro Launch**  |           **₹149/mo India · US$1.99/mo global** | Individual developers                     |
| **Team Launch** | **₹399/user/mo India · US$4.99/user/mo global** | Small engineering teams                   |
| **Business**    |                                          Custom | Larger deployments, support, procurement  |

**Launch trial:** eligible new accounts get **30 days of Pro** with no automatic paid conversion unless they explicitly choose a paid subscription.

Third-party AI subscriptions/API usage are separate. Taxes and final checkout terms are controlled by KMJ Main Platform.

See the full **[plan and premium feature matrix](docs/PRICING.md)**.

## Premium capability categories

Paid plans are designed around capabilities that create ongoing hosted value rather than artificially crippling the open-source core:

- hosted account linking and managed onboarding;
- higher device, project and concurrency limits;
- signed commercial entitlements and renewable access;
- extended job history;
- shared team policies and administration;
- audit export and enterprise identity controls;
- priority support, procurement and optional SLA terms.

Paid-only features must be enforced by server-side policy and signed entitlements—not just hidden in a dashboard.

## Security boundaries

CodeBridge is intentionally not a remote shell product.

| Boundary            | Enforcement                                                       |
| ------------------- | ----------------------------------------------------------------- |
| Device reachability | Agent-initiated outbound connection                               |
| Project access      | Explicit administrator-approved project roots                     |
| Read operations     | Bounded project-scoped reads/search                               |
| Write operations    | Preconditions, exact-fragment checks, atomic replacement patterns |
| Command execution   | No generic shell tool; quality gates are administrator-configured |
| Authorization       | Tenant and permission checks at gateway and device layers         |
| Sensitive output    | Recognized secrets can be redacted before results are returned    |
| Commercial access   | Signed entitlement verification                                   |

- Agents poll outbound.
- Gateway and agent both enforce authorization.
- Projects are explicitly configured.
- Reads/search/logs are bounded.
- Recognized secrets are redacted before results are returned.
- Writes use preconditions and atomic replacement patterns.
- Quality gates are fixed by administrators.
- Commercial entitlements are cryptographically verifiable.

A quality gate still executes real project code. Run untrusted code in a properly isolated environment.

Read **[SECURITY.md](SECURITY.md)** before production use.

## Configuration reference

CodeBridge uses **JSON configuration as the primary interface**. Local/developer mode does not require a large environment-variable surface.

### Environment variables

| Variable                    | Required                            | Default | Safe example                                                      |
| --------------------------- | ----------------------------------- | ------- | ----------------------------------------------------------------- |
| `CODEBRIDGE_GATEWAY_CONFIG` | **Yes** for hosted `npm start` mode | None    | Private JSON stored in the hosting provider's secret/config store |
| `PORT`                      | No                                  | `10000` | `10000`                                                           |

`CODEBRIDGE_GATEWAY_CONFIG` contains the complete hosted gateway configuration and must be treated as sensitive. Hosted startup fails closed when it is missing or invalid. `PORT` controls the hosted HTTP listen port; the hosted entry point binds to `0.0.0.0`.

> Local/developer mode does **not** require these environment variables; it normally uses private `gateway.json` and `agent.json` files created outside the project. Do **not** commit `CODEBRIDGE_GATEWAY_CONFIG`, paste it into issues/chat, or put secrets in command-line URLs.

### Gateway JSON

| Setting              | Required               | Safe default / example                          | Notes                                                                                |
| -------------------- | ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `host`               | No                     | `127.0.0.1`                                     | Safe local default. Hosted mode overrides this to `0.0.0.0`.                         |
| `port`               | No                     | `8787`                                          | Local gateway default.                                                               |
| `deviceTimeoutMs`    | No                     | `15000`                                         | Allowed range: 100–120000 ms.                                                        |
| `pollWaitMs`         | No                     | `45000`                                         | Empty agent long-poll wait. Work is still delivered immediately by gateway wake-up.  |
| `allowedHosts`       | No                     | `[]` locally                                    | For public hosting, explicitly list the exact public hostname; do not use wildcards. |
| `allowedOrigins`     | No                     | `[]`                                            | Add only approved browser origins when required.                                     |
| `users`              | **Yes**                | Generated by `npm run init`                     | Maps users to tenants, devices/projects, permissions, and auth identity.             |
| `agents`             | **Yes**                | Generated by `npm run init`                     | Each device gets its own tenant-bound token hash.                                    |
| `oauth`              | Hosted production path | Real HTTPS issuer/resource                      | Configure exactly one of embedded public `jwks` or same-origin `jwksUri`.            |
| `agentIntrospection` | No                     | Derived from OAuth issuer when OAuth is enabled | Default cache: 60 seconds.                                                           |
| `github`             | No                     | Disabled unless configured                      | Server-side GitHub token env reference, repository allowlist and short cache.        |

### Agent JSON

| Setting               | Required | Safe default / example                        | Notes                                                    |
| --------------------- | -------- | --------------------------------------------- | -------------------------------------------------------- |
| `gateway`             | **Yes**  | `http://127.0.0.1:8787` for local development | Use HTTPS for non-loopback deployments.                  |
| `token`               | **Yes**  | Generated random credential                   | Minimum 32 characters; keep private.                     |
| `id`                  | **Yes**  | `device1`                                     | Device identifier.                                       |
| `tenant`              | **Yes**  | `kmj` in the generated local example          | Must match the authorized tenant.                        |
| `stateDir`            | **Yes**  | Private directory outside the project         | Stores agent state/journal data.                         |
| `pollMs`              | No       | `250`                                         | Allowed range: 10–5000 ms.                               |
| `projects[].root`     | **Yes**  | Absolute project path                         | Keep scope as narrow as practical.                       |
| `projects[].writable` | No       | **`false`**                                   | Safe default: read-only.                                 |
| `projects[].gates`    | No       | `{}`                                          | Add only administrator-approved commands and arguments.  |
| `license.mode`        | **Yes**  | `free` for local/community mode               | Signed mode requires a token file and verification keys. |

### Copy-paste configuration examples

These examples are intentionally conservative: loopback/local where possible, read-only project access, and no real credentials committed to the repository.

#### Safe local setup

Create a private directory **outside** the project:

```bash
mkdir -p /tmp/kmj-codebridge-private
chmod 700 /tmp/kmj-codebridge-private
```

Create `gateway.json`:

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "users": [
    {
      "id": "owner",
      "tenant": "kmj",
      "tokenHash": "<SHA256_OF_PRIVATE_CLIENT_TOKEN>",
      "devices": {
        "device1": ["project1"]
      },
      "permissions": ["read"]
    }
  ],
  "agents": [
    {
      "id": "device1",
      "tenant": "kmj",
      "tokenHash": "<SHA256_OF_PRIVATE_AGENT_TOKEN>"
    }
  ]
}
```

Create `agent.json`:

```json
{
  "gateway": "http://127.0.0.1:8787",
  "token": "<PRIVATE_AGENT_TOKEN_MIN_32_CHARS>",
  "id": "device1",
  "tenant": "kmj",
  "stateDir": "/tmp/kmj-codebridge-private/state",
  "pollMs": 250,
  "projects": [
    {
      "id": "project1",
      "root": "/absolute/path/to/project",
      "writable": false,
      "gates": {}
    }
  ],
  "license": {
    "mode": "free"
  }
}
```

Start both processes:

```bash
npm run gateway -- /tmp/kmj-codebridge-private/gateway.json
npm run agent -- /tmp/kmj-codebridge-private/agent.json
```

For a real local setup, prefer `npm run init -- /private/config-dir /absolute/project` because it generates independent random credentials and stores only token hashes in the gateway config.

#### Safe hosted setup

Store the complete gateway JSON in your hosting provider's **private secret/config store**, not in the repository.

Example shell environment:

```bash
export PORT=10000
export CODEBRIDGE_GATEWAY_CONFIG='{"oauth":{"issuer":"https://auth.example.com","resource":"https://codebridge.example.com/mcp","jwksUri":"https://auth.example.com/.well-known/jwks.json"},"allowedHosts":["codebridge.example.com"],"allowedOrigins":[],"users":[{"id":"owner","tenant":"kmj","subject":"user-123","devices":{"device1":["project1"]},"permissions":["read"]}],"agents":[{"id":"device1","tenant":"kmj","tokenHash":"<SHA256_OF_PRIVATE_AGENT_TOKEN>"}]}'
npm start
```

Replace `auth.example.com`, `codebridge.example.com`, subjects, device/project IDs, and token hashes with your real approved values.

> For production, prefer the hosting platform's secret manager over exporting sensitive JSON in an interactive shell. Keep `allowedHosts` exact, avoid wildcard origins, and do not enable write/execute permissions until they are required.

### Minimal local example

`npm run init` creates private `gateway.json`, `agent.json`, and `client-token.txt` outside the project and starts projects read-only.

```json
{
  "gateway": "http://127.0.0.1:8787",
  "id": "device1",
  "tenant": "kmj",
  "stateDir": "/private/codebridge/state",
  "pollMs": 250,
  "projects": [
    {
      "id": "project1",
      "root": "/absolute/path/to/project",
      "writable": false,
      "gates": {}
    }
  ],
  "license": { "mode": "free" }
}
```

The real generated agent file also contains a random private `token`; it is intentionally omitted from this public example.

For deployment-specific details, see **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** and **[docs/OAUTH.md](docs/OAUTH.md)**.

## Troubleshooting

Use the least-invasive check first. Avoid deleting configuration, regenerating credentials, or changing production permissions until you have identified the failing boundary.

| Symptom                             | Check                                                                                              | Safe recovery                                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm ci` fails                      | Confirm Node.js 24+ and npm are active with `node --version` and `npm --version`                   | Use the supported Node version, then rerun `npm ci --ignore-scripts`. Do not delete unrelated project files. |
| `npm run check` fails               | Run `npm run check` again and read the first reported formatter, validation, or policy failure     | Fix the reported source/documentation issue rather than bypassing the check.                                 |
| Tests fail                          | Run `npm test` and isolate the first deterministic failure                                         | Reproduce locally, fix the underlying behavior, and rerun the full relevant test set.                        |
| Gateway does not start              | Verify the configured gateway file path exists and is outside the repository                       | Correct the path or configuration. Do not move credentials into the repository for convenience.              |
| Agent cannot connect                | Confirm the gateway is reachable from the device and the agent is using the intended configuration | Check network reachability, device authorization, and configuration values before rotating credentials.      |
| Device appears offline              | Confirm the agent process is running and the device can make outbound connections                  | Restart only the CodeBridge agent process/service after checking logs; avoid broad system changes first.     |
| Project is not visible              | Confirm the project root was explicitly added to the agent configuration                           | Add the intended project root rather than widening access to an entire drive or home directory.              |
| Read works but write fails          | Confirm write-capable tools are enabled and the file precondition/hash still matches               | Refresh the file state and retry the guarded edit. Do not disable preconditions to force an overwrite.       |
| Quality gate is rejected            | Confirm the requested gate is present in the administrator-approved configuration                  | Add or correct the approved gate definition. Do not expose a generic shell as a shortcut.                    |
| Client cannot discover tools        | Verify the MCP endpoint/client configuration and use the client-specific setup guide               | Recheck [docs/CLIENTS.md](docs/CLIENTS.md) and reconnect the client after correcting configuration.          |
| Authentication or entitlement fails | Confirm tenant/device identity, current authorization, and entitlement state                       | Re-enroll or renew through the supported account flow. Do not hard-code or bypass entitlement checks.        |

### Useful diagnostic commands

Run these from the CodeBridge repository unless the relevant command documents another location:

```bash
node --version
npm --version
git status
npm run check
npm test
npm run scan:secrets
```

For configuration-specific diagnosis, use the built-in CodeBridge diagnostic tooling where available, such as `connection_doctor`, rather than exposing extra shell access.

### Safe recovery order

1. capture the first reproducible error;
2. verify runtime versions and configuration paths;
3. confirm gateway, device, tenant, and project scope;
4. retry the smallest affected operation;
5. rerun the relevant quality gate;
6. rotate credentials only when there is evidence they are invalid or compromised;
7. if the problem persists, open a minimal reproducible issue without including secrets.

Never paste private keys, tokens, enrollment secrets, production credentials, or full private configuration into a public GitHub issue.

## FAQ

### Do I need to expose SSH or another inbound port?

No. The CodeBridge device agent is designed to initiate outbound connectivity. You still control which device and project roots are authorized.

### Can CodeBridge work with a VPS as well as a local computer?

Yes. The agent model is intended for authorized laptops, workstations, and VPS environments, subject to the configured project scope and platform support documented in this repository.

### Does CodeBridge give the AI a full shell?

No. CodeBridge intentionally does not expose a generic unrestricted shell tool. Execution is limited to defined tools and administrator-configured quality gates.

### Can the AI edit files?

Yes, when write-capable tools are enabled for an authorized project. Writes use preconditions and guarded replacement patterns to reduce blind or stale overwrites.

### Can I start read-only?

Yes, and that is the recommended first step. Verify device identity, project scope, and read-only tools before enabling writes.

### Which AI clients can use CodeBridge?

The repository includes integration paths for ChatGPT, Claude Code, Claude Desktop, Claude.ai where supported, and other compatible MCP clients. Client capabilities can differ, so use [docs/CLIENTS.md](docs/CLIENTS.md) as the current integration reference.

### Does CodeBridge make untrusted code safe to run?

No. A configured quality gate can execute real project code. Treat untrusted repositories and build scripts as untrusted code and use appropriate isolation.

### Are secrets automatically safe?

No security control is absolute. CodeBridge includes bounded output and recognized-secret redaction, but you should still keep credentials and private configuration outside repositories, avoid exposing unnecessary files, and never commit production secrets.

### Is hosted production onboarding fully ready?

Not yet. Local/source workflows are usable, while fresh zero-touch production enrollment still depends on the matching KMJ Main Platform enrollment and approval APIs. See [docs/STATUS.md](docs/STATUS.md) and [docs/ENROLLMENT.md](docs/ENROLLMENT.md).

## Supported clients

| Client            | Integration                          |
| ----------------- | ------------------------------------ |
| ChatGPT           | OpenAI plugin package + remote MCP   |
| Claude Code       | Claude plugin / MCP                  |
| Claude Desktop    | Custom MCP connector                 |
| Claude.ai         | Custom MCP connector where supported |
| Other MCP clients | Streamable HTTP MCP                  |

Client capabilities and hosted availability can differ. See [docs/CLIENTS.md](docs/CLIENTS.md).

## Open core, commercial service

The source in this repository is licensed under **Apache License 2.0**. You may use, modify and distribute it subject to that license.

KMJ TECHNO’s trademarks, hosted infrastructure, billing/account systems, commercial support and any service-side code not published under an open-source license are separate from the Apache-2.0 grant.

See:

- [Launch plans & premium features](docs/PRICING.md)
- [Premium delivery roadmap](docs/PREMIUM-ROADMAP.md)
- [Launch & community playbook](docs/LAUNCH.md)
- [Commercial Terms](docs/COMMERCIAL-TERMS.md)
- [Licensing & entitlement contract](docs/LICENSING.md)
- [Privacy notice](plugin/PRIVACY.md)
- [Security](SECURITY.md)

## Current status

CodeBridge is under active development. The repository contains a working Streamable HTTP MCP gateway, outbound device agent, scoped file tools, guarded writes, configured quality gates, durable jobs, entitlement verification and real test coverage.

Production readiness is tracked explicitly; unsupported features are not presented as shipped. See **[docs/STATUS.md](docs/STATUS.md)**.

## Contributing

Good contributions make CodeBridge safer, more portable, or easier to verify.

Before opening a pull request:

1. keep the change focused;
2. describe the security boundary affected by the change;
3. add or update deterministic tests where behavior changes;
4. run `npm run check`, `npm test`, and `npm run scan:secrets`;
5. do not include credentials, private infrastructure details, or production secrets;
6. avoid weakening authorization, redaction, write preconditions, or quality-gate restrictions merely to make a test pass;
7. include reproducible evidence for compatibility or environment-specific claims.

Useful contributions include:

- MCP client interoperability improvements;
- device-agent compatibility fixes;
- safer file-editing primitives;
- better diagnostics and bounded error reporting;
- security tests;
- documentation and onboarding improvements;
- reproducible platform compatibility results.

Found a bug? Open a minimal reproduction. Need a new tool? Describe the required capability **and** the intended safety boundary.

Start with **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[SECURITY.md](SECURITY.md)**.

### If CodeBridge solves a real problem for you, ⭐ star the repository.

A star helps other developers discover the project. A reproducible issue, integration note, test case, or focused pull request helps even more.

---

<p align="center">
  <strong>KMJ TECHNO</strong><br>
  Innovate · Build · Scale
</p>

## License

Copyright 2026 KMJ TECHNO.

KMJ CodeBridge source is licensed under the [Apache License 2.0](LICENSE). The Apache License does not grant permission to use KMJ TECHNO trade names, trademarks, service marks or product names except as permitted by applicable law and the license.

## About KMJ TECHNO

KMJ CodeBridge is developed by **KMJ TECHNO**, founded and led by **Narendra Singh Kushwah**. The company builds AI-native software, secure developer infrastructure, autonomous engineering systems, remote-access technologies, and enterprise digital products.

Learn more at <https://kmjtechno.com>.

## Explore the KMJ open-source ecosystem

If you discovered this project through one KMJ tool, the rest of the stack may be useful too:

- **[KMJ CodeBridge](https://github.com/kmjtechno/kmj-codebridge)** — secure AI-to-project connectivity for authorized development environments.
- **[KMJ OmniDesk](https://github.com/kmjtechno/kmj-omnidesk)** — direct-first remote access engineered for speed, resilience, and measurable trust.
- **[KMJ Desktop Commander](https://github.com/kmjtechno/kmj-desktop-commander)** — policy-controlled desktop and remote engineering operations.
- **[KMJ Forge](https://github.com/kmjtechno/kmj-forge)** — evidence-driven software engineering workflows for humans and AI.

**KMJ TECHNO · Innovate · Build · Scale** — <https://kmjtechno.com>
