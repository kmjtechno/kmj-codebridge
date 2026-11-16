# KMJ CodeBridge — verified-free-cloud-only autonomous coding

**Source preview, not a permission grant or deployed worker.** Existing
`autopilotCodingWorker` remains disabled unless the owner separately enables
it for an enrolled writable project, with an exact safe-gate recipe, license
grants, isolated worktree availability and signed runtime admission.

## Cloud-only configuration (opt-in)

Use these additional fields inside the existing project
`autopilotCodingWorker` configuration only after verifying the runtime,
worktrees and actual zero-cost provider:

```json
{
  "enabled": false,
  "inferenceRoute": "verified-free-cloud-only",
  "localProcessingApproved": false,
  "cloudProxyApproved": false,
  "cloudSourceTransferApproved": false,
  "model": "auto:code"
}
```

These are default-DENY examples, **not** a runnable configuration: the normal
`recipes`, model limits and project scope are required. The owner must
explicitly authorize **both** local proxy contact and external transfer of
bounded, allowlisted tracked source context. Do not enable consent merely
because the user asked for zero-cost AI; provider code transfer is a separate
decision. Legacy `local-only` mode cannot be mixed with cloud consent.

The local proxy is a **network client**, not a local inference model. The
cloud-only coding adapter never invokes Ollama. It uses only owner-approved,
advertised `auto:<chain>` FreeLLMAPI routes and has no local or paid fallback.

## Non-negotiable zero-charge gate

`createFreeLlmApiClient` defaults to `verifyZeroCostChain=null`.
Consequently **generation is rejected before the HTTP POST**, even if a
project enables cloud mode and the loopback proxy responds. An owner-approved
chain name, advertised model or zero-cost _claim_ is insufficient. Before
enabling, install a separate trusted, short-lived, account-specific verifier
for actual upstream zero-price input/output, available free quota and
immutable no-paid-fallback route binding. This verifier must live in
owner-protected device code, never MCP arguments, .env flags or GitHub files.
It must be rechecked on every attempt/retry and on revocation. No verifier is
included in this branch.

Cloud attribution reports `provider=freellmapi-loopback`,
`execution=verified_zero_cost_route_admission`, `paidInference=null` and
`cloudFallback=null`: it never claims which upstream executed or that the
final provider invoice is independently known.

## Source/CI boundaries

The existing coding worker enforces task recipe + exact pinned Git HEAD,
tracked regular source-only context, safe paths, explicit license, lease,
a _fresh_ isolated lane, diff validation, non-destructive isolated patch
application and reviewed verification gate. A cloud response is untrusted;
completed CI leaves a review candidate, **not a commit, merge or deploy**.
Cloud consent is revalidated after model status and generation, and its
identity is bound into the approval fingerprint.

Before calling this production-ready, verify all of the following on
**P520**: the owner-signed version containing this change is active,
`worktree_lane_diagnose` identifies and safely resolves the existing
`WORKTREE_GIT_FAILED` without touching three dirty lanes; a fresh clean
lane is available; cloud zero-cost attestor actually exists; proxy and
external source transfer consent are given; real coding tasks complete
through approved tests with restart recovery; and an independent no-charge
receipt is available. A green GitHub PR or an active hourly ChatGPT task
is **not** proof of 24x7 local autonomous worker execution.
