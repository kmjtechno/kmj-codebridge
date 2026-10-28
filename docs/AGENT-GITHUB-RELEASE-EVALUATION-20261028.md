# Public agent architecture evaluation and CodeBridge release gates (2026-10-28)

This is a **curated, read-only source review**, not a claim to have audited every
public GitHub repository. No third-party source code, binaries, or dependency
was copied or installed by this change.

| Public project | Useful verified approach | CodeBridge decision |
| --- | --- | --- |
| [OpenHands](https://github.com/OpenHands/OpenHands) | Separate agent server/SDK, UI, client and automation concerns | Keep gateway, on-device supervisor, agent worker, and scheduling separated; never put root credentials in an AI executor |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | Simple, inspectable action history and separately sandboxed execution | Reuse CodeBridge's audit ledger and lease-bound fixed tools; do **not** import a generic bash execution tool |
| [Aider](https://github.com/Aider-AI/aider) | Repository context and automatic lint/tests after edits | Use current bounded context_pack, SHA-precondition edits and exact-head CI; prove a real patch/test/PR loop before autonomous marketing |
| [goose](https://github.com/block/goose) | MCP extension and permission boundaries | Preserve per-device/project scopes and owner approval for privileged operations |
| [MCP Inspector](https://github.com/modelcontextprotocol/inspector) | Scriptable CLI / UI / TUI inspection of actual MCP server protocol | Add an operator-owned **live authenticated** initialize/tools-list/denied-out-of-scope smoke gate to release QA; no proof from a source catalog alone |
| [Sigstore cosign](https://github.com/sigstore/cosign) | Signing, verifier identity, transparency bundles | Evaluate offline verification for future signed releases; keep existing Ed25519 owner signing. Do not introduce external key or paid-provider dependency without approval |

## Immediate release security fix

`scripts/release-acceptance-gate.mjs` previously checked `lstatSync(path)`
then separately called `readFileSync(path)`. The pathname could have been
replaced between inspection and use. It now opens the file once, verifies the
**opened descriptor** and **path identity**, reads at most 256 KiB, and checks
inode and size/time metadata again before accepting JSON. The implementation
uses `O_NOFOLLOW` where supported, fails closed on symlinks/non-files,
mutation and malformed input, and leaves the original caller-supplied evidence
semantics unchanged. This does **not** validate a cryptographic signature.

## Current hard blockers, independent of CI green

- CodeBridge source `main` is ahead of KMJ-elite enrolled agent v0.3.2
  runtime `932b44cef729ae049340818f52353e5c3bcc498d`.
- The exact signed development update timer/refresh is not installed on the
  host. Source-level PR tests are not a live release.
- The root-owned fixed non-root Git probe was installed but failed exit 3;
  some original checkout pack files are unreadable to `kmjdevci`. Never
  broaden protected checkout ACLs or execute an unreviewed repair script.
- Neither online VPS had a verified running Ollama model during the
  assessment. An initial worker loop is not evidence of useful AI coding.
- Zero-additional-cost constraints and protected Main Platform production,
  existing owner data, DNS, credentials, and privileged approvals remain in
  force.

## Promotion sequence

1. Pass exact-head Linux/Windows tests, dependency/secret scan and package
   integrity checks; freeze immutable source, manifest, archive digest and
   owner signing material.
2. Operator-owned signed **staging** deployment only, with fixed allowlisted
   unit, idle leases, audit evidence, healthy current release, explicit
   rollback target and automatic canary failure recovery. Verify the source
   SHA of the *actual running gateway/agent*, not GitHub `main`.
3. Run authenticated MCP protocol and negative authorization tests with the
   currently deployed tool catalog and enrolled project. Record redacted
   receipts. Do not claim permission from catalog membership.
4. Prepare a separate owner-reviewed source checkout for the dedicated
   non-root identity with exact SHA provenance, no sensitive shared history;
   attest fixed service/helper pins and pass real systemd tests.
5. Explicitly opt into a free on-host or owner-provided local model and prove
   isolated coding, bounded resource usage, tests, reviewed PR, device reboot
   recovery and lease cancellation. Only then claim 24x7 coding is live.

All release-evidence statuses remain *assertions* until independently checked
against the real host, issuer, signed artifact and GitHub CI. A green source
CI never grants root access or authorizes a production cutover.
