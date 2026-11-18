# Release acceptance: evidence-only, fail-closed review

KMJ CodeBridge already packages runtime archives, SBOMs, provenance and an
owner-controlled Ed25519 signing flow. This **read-only** gate keeps unrelated
claims separate so a signed _staged_ runtime is never mistaken for a deployed
or approved stable release.

Run on an operator-owned **non-secret** evidence file:

```bash
node scripts/release-acceptance-gate.mjs /path/to/release-evidence.json
```

The command returns exit code **1** and `assessment=BLOCKED` for missing or
red checks. Exit **0** means **READY_FOR_MANUAL_OWNER_VERIFICATION**, _not_
release approval. File read is bounded to 256 KiB; symlinks are rejected.
It performs no GitHub API requests, no model calls, no signing, no network
mutations, and no automatic activation.

## Owner release CLI admission

The `npm run release` / `scripts/release.sh` signing workflow is a
**separate production-facing operation** from this evidence-only diagnostic.
It now requires an authenticated GitHub CLI session and a complete exact-commit
GitHub Actions response **before** selecting a signed sequence, prompting the
owner or accessing the private signing workflow. Offline, rate-limited,
unauthenticated and ambiguous CI are blockers; the script does **not** fall
back to signing without GitHub checks.

`scripts/release-ci-gate.mjs` admits only all five completed/success official
GitHub Actions job names at the requested 40-character source commit:
`registry_manifest`, Linux/Ubuntu, Windows, `clients` and `distribution`.
Additional checks must also be green. Duplicate mandatory names, wrong commit,
untrusted check apps, skipped/neutral checks, hidden pagination and incomplete
responses fail closed. This is a source-build gate, **not** a replacement for
independent owner Ed25519 signature, public archive and canary/rollback proof.

Release history is enumerated from actual recursively tracked signed
`releases/stable/<SHA>/release-manifest.json` manifests, not a parent tree
node. On failure, the helper may clean only its own disposable worktrees and
a release branch created by **this** invocation; it must never remove an
owner's pre-existing same-named branch. Release PR creation still requires
authenticated GitHub permissions. No automatic merge, signer key export,
gateway restart or production cutover follows from a CI PASS.

## Evidence shape

```json
{
  "schema": 1,
  "source": { "revision": "<exact 40-hex source SHA>" },
  "ci": {
    "revision": "<same SHA>",
    "checks": [
      {
        "name": "registry_manifest",
        "headSha": "<same SHA>",
        "status": "completed",
        "conclusion": "success"
      }
    ]
  },
  "candidate": {
    "revision": "<same SHA>",
    "sequence": 11,
    "archiveSha256": "<64-hex SHA-256>",
    "ownerSignatureVerification": "PASS",
    "archiveDigestVerification": "PASS"
  },
  "hosted": {
    "revision": "<same SHA>",
    "status": "ok",
    "githubReady": true,
    "githubReadinessState": "ready"
  },
  "operator": {
    "stagedRevision": "<same SHA>",
    "stagedSequence": 11,
    "acceptedSequence": 10,
    "preflight": "PASS",
    "browserQa": "PASS",
    "dispatchReceiptQa": "PASS",
    "rollbackAvailable": true,
    "activeJobs": 0,
    "renderTcpReachable": true
  }
}
```

The truncated sample intentionally fails until the **full** check list
(including Ubuntu and Windows, clients, distribution, gateway, GitHub bridge,
OAuth, MCP catalog and deployment parity) is supplied with the exact revision
and completed-success conclusion. Any additional red/pending CI check also
blocks.

**Evidence is operator-supplied assertions.** The gate does not fetch current
GitHub head, verify an Ed25519 signature, read the real archive, prove live
network reachability, or authenticate a client MCP session. Each must be
verified independently with the existing CodeBridge pinned signing,
preflight, supervisor, hosted-smoke and job-receipt procedures. Never
fabricate PASS fields merely to obtain an exit code 0.

## 2026-10-17 rollout example

Signed **Sequence 11** (`0cfdf79916e78b90a19ceae5906e5ebf04066e67`)
passed isolated Chrome 9/9, local dispatcher -> real Chrome -> verified
receipt, and staged preflight. Production was still on signed **Sequence 10**
(`d630795a56357dccdacf9ed98c530b105f3c697b`). New `main` commits
overtook the staged candidate; current exact-head CI sometimes reported
`github_bridge=GITHUB_RATE_LIMIT`. The KMJ-elite VPS could not establish TCP
handshakes to Render IPs `216.24.57.16` and `216.24.57.18`, despite
working HTTPS to GitHub and kmjtechno.com.

For this snapshot, the correct combined decision is **BLOCKED**, regardless
of staged Chrome test success. Do not deploy to try to repair an upstream
network failure. Do not reuse green checks from a different SHA, disable
failing gates, expose keys or touch the P720 dirty checkout.

Manual final owner approval is required **after** fresh CI, deployment,
cryptographic signature, connectivity and safe rollback have separately
passed.
