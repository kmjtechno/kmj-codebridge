# Threat model, support matrix and benchmark harness (roadmap M0)

Status: source-level baseline. It restates controls already documented in
[SECURITY.md](../SECURITY.md) and tested in CI. It adds no new guarantee and
is not a security review. Anything not listed as tested below is **not
supported**.

## 1. Supported platforms

| Platform                   | Evidence                                                           | Status                  |
| -------------------------- | ------------------------------------------------------------------ | ----------------------- |
| Linux x86_64, Ubuntu 24.04 | `CodeBridge CI` matrix `ubuntu-24.04` (`.github/workflows/ci.yml`) | Tested in CI            |
| Windows x86_64             | `CodeBridge CI` matrix `windows-latest`                            | Tested in CI            |
| Linux arm64, macOS         | none                                                               | Not supported, untested |

- Runtime: Node.js `>=24.0.0` (`package.json` `engines`).
- Real hosts (KMJ-elite, P520) are operational deployments, not a certified
  matrix. A passing CI run is not proof that a given customer machine works.
- Rule from the roadmap: publish exact tested OS versions, never "every computer".
- GUI/HIL tests are not covered by this matrix and stay pending until proven.

## 2. Assets and trust boundaries

| Asset                                     | Boundary                                                |
| ----------------------------------------- | ------------------------------------------------------- |
| Project source and working tree           | Authorized project root only; denylisted paths excluded |
| Credentials, tokens, signing keys         | Never in project roots, logs, PRs or tool output        |
| Owner release signing key                 | Owner machine only; Claude/AI chats never touch it      |
| Device state, config, license/entitlement | Outside project roots; hashed bearer tokens at gateway  |
| Production hosts                          | Fixed named operations only; no generic root shell      |
| Job journal and audit records             | Local, bounded (1,000 records); protect from tampering  |

Actors: AI client (untrusted instructions), authenticated user, device agent
(OS rights of its account), project code and quality gates (may be hostile),
local administrator (out of scope), network attacker.

## 3. Threats and current mitigations

| Threat                                    | Mitigation in source                                                     | Residual risk                                |
| ----------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| Prompt injection drives arbitrary command | Fixed administrator-defined commands, no shell interpolation             | Gates run trusted code with agent rights     |
| Path traversal / symlink / hardlink       | Path validation, symlink and hardlink exclusion, sensitive-path denylist | Not a kernel sandbox; local race possible    |
| Lost update / stale write                 | `expectedHash` on write/edit/move/copy, `CONTENT_CONFLICT`               | Single-host only                             |
| Cross-tenant/device/project access        | Per-tenant, device and project checks; separate user/agent credentials   | Bearer tokens need out-of-band rotation      |
| Secret leakage in output                  | Credential-pattern redaction, bounded logs                               | Defense in depth, not proof                  |
| Forged entitlement                        | Ed25519 signed entitlements, verification keys                           | Local admin can alter binaries and clocks    |
| Duplicate/replayed job                    | Durable request keys, no silent relaunch of interrupted jobs             | Not exactly-once; crash output may be lost   |
| Privileged action abuse                   | Fixed-action supervisor tools, execute grant + typed confirmation        | Host-side install is owner-run               |
| Untrusted repository code                 | Not supported on the shared agent                                        | Needs separate VM/container worker           |
| Unsafe self-update/release                | Owner-signed manifests, monotonic sequence, rollback                     | Origin publish and activation stay owner-run |

## 4. Explicit non-goals (roadmap exclusions)

- Unrestricted root shell as a default tool.
- CPU/RAM hard limits, HA, durable gateway queueing, tenant-wide quotas
  (listed as not yet implemented in SECURITY.md).
- Autonomous production deployment, DNS change, payment or release publication.

## 5. Benchmark harness

`node scripts/benchmark.js` (see its header and
[PERFORMANCE-ARCHITECTURE.md](PERFORMANCE-ARCHITECTURE.md)) reports three
separately labeled kinds: process idle (Linux `/proc`, real services only),
in-process dispatcher latency, and gateway `/healthz` latency. Values that
cannot be measured are reported as unsupported, never estimated. No benchmark
numbers are claimed in this document.

## 6. Open items (owner decisions)

- Dedicated security review before any production-grade claim.
- Linux arm64 and macOS entries need real CI before being listed.
- Customer-facing publication of this matrix.
