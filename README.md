<p align="center">
  <img src="plugin/assets/logo.png" alt="KMJ TECHNO" width="210">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/kmjtechno/kmj-codebridge/brand/fix-corrupt-cinematic-hero/docs/assets/codebridge-cinematic-hero-final.jpg" alt="KMJ CodeBridge — Connect your systems. Build with AI." width="100%">
</p>

<h1 align="center">KMJ CodeBridge</h1>

<p align="center"><strong>Connect your systems. Build with AI.</strong></p>

<p align="center">
  A secure, vendor-neutral MCP bridge that lets AI assistants work with the <em>authorized projects</em> on your laptops, workstations and VPSs—without giving them an unrestricted shell or requiring an inbound device port.
</p>

<p align="center">
  <a href="https://github.com/kmjtechno/kmj-codebridge/actions/workflows/ci.yml"><img alt="CodeBridge CI" src="https://github.com/kmjtechno/kmj-codebridge/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/kmjtechno/kmj-codebridge/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/kmjtechno/kmj-codebridge?style=flat&color=ED010B"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-ED010B"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/Node-24%2B-111111">
  <img alt="MCP" src="https://img.shields.io/badge/protocol-MCP-111111">
  <img alt="Developer Preview" src="https://img.shields.io/badge/status-developer%20preview-ED010B">
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

<p align="center">
  <img src="docs/assets/codebridge-architecture-cinematic-v2.svg" alt="KMJ CodeBridge architecture" width="100%">
</p>

## The workflow

```text
AI assistant
    ↓ MCP
CodeBridge gateway
    ↓ authorized tool request
Outbound-polling device agent
    ↓
inspect → edit → test → verify
    ↓
bounded result back to the AI conversation
```

The gateway cannot independently browse your machine. The device agent must be online, authorized for the tenant, and configured for the requested project.

## What you can do

| Tool family | Examples                                                   | Safety boundary                                      |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| Discover    | `list_devices`, `inspect_project`, `connection_doctor`     | Tenant/project scoped                                |
| Read        | `read_file`, `list_directory`, `search_code`, `git_status` | Bounded output + project root                        |
| Edit        | `edit_file`, `write_file`, `preview_file`                  | Expected-hash / exact-fragment checks                |
| Verify      | `run_quality_gate`                                         | Only administrator-configured executable + arguments |
| Jobs        | `get_job_status`, `cancel_job`                             | Durable bounded job state                            |

No generic “run any shell command” MCP tool is exposed.

## Quick start for developers

Requires Node.js 24+ and npm.

```bash
git clone https://github.com/kmjtechno/kmj-codebridge.git
cd kmj-codebridge
npm ci --ignore-scripts
npm run check
npm test
npm run scan:secrets
```

Create private configuration **outside the repository**:

```bash
npm run init -- /absolute/private-codebridge-config /absolute/development-project
npm run gateway -- /absolute/private-codebridge-config/gateway.json
```

In another terminal:

```bash
npm run agent -- /absolute/private-codebridge-config/agent.json
```

Start read-only. Enable writes only for projects you explicitly approve. Never commit generated credentials.

See **[AI client setup](docs/CLIENTS.md)** for ChatGPT, Claude Code, Claude Desktop, Claude.ai and generic MCP clients.

## One-command VPS enrollment

The target production flow is:

```bash
curl -fsSL https://OFFICIAL-CODEBRIDGE-DOMAIN/install | sudo bash
```

The installer is designed to detect architecture, stage the runtime, enroll the device, install a hardened systemd service and verify gateway connectivity without installing a GitHub self-hosted runner.

**Current production gate:** fresh zero-touch enrollment depends on the matching KMJ Main Platform enrollment/approval APIs being live. Existing source and local developer mode remain usable. See [enrollment contract](docs/ENROLLMENT.md) and [current status](docs/STATUS.md).

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

## Security model

CodeBridge is intentionally not a remote shell product.

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

## Build with us

Good open-source projects grow through useful issues, reproducible bugs and real contributions.

- Found a bug? Open a minimal reproduction.
- Need a tool? Describe the safety boundary as well as the feature.
- Running CodeBridge in a new environment? Share the compatibility result.
- Want to contribute? Start with [CONTRIBUTING.md](CONTRIBUTING.md).

### If CodeBridge solves a real problem for you, ⭐ star the repository.

A star helps other developers discover the project. Sharing a working demo, integration note or reproducible improvement helps even more.

---

<p align="center">
  <strong>KMJ TECHNO</strong><br>
  Innovate · Build · Scale
</p>

## License

Copyright 2026 KMJ TECHNO.

KMJ CodeBridge source is licensed under the [Apache License 2.0](LICENSE). The Apache License does not grant permission to use KMJ TECHNO trade names, trademarks, service marks or product names except as permitted by applicable law and the license.
