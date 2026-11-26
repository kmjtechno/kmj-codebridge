# Native KMJ ModelFabric coding activation

This is the native route, not the legacy FreeLLMAPI adapter. A signed runtime,
a working Supervisor, a queue entry, and a started worker are separate facts.
None alone proves autonomous coding.

## Owner admission

Use the KMJ Main Platform owner panel at
https://kmjtechno.com/operator/modelfabric to create a dedicated, revocable,
short-lived token with private-source-coding scope. Never paste the token into
a chat, command line, Git, job output or a PR. Explicitly approve transfer of
only the selected tracked source files to the eligible free cloud provider.
Use a protected, owner-installed service environment for the token; preserve
existing enrollment and never print the effective environment.

For the specific writable project in its protected agent configuration, use
these worker settings (illustrative recipe, not a drop-in configuration):

```json
{
  "enabled": true,
  "inferenceRoute": "native-verified-free-cloud-only",
  "nativeModelFabricApproved": true,
  "cloudSourceTransferApproved": true,
  "cloudProxyApproved": false,
  "localProcessingApproved": false,
  "nativeTokenEnv": "CODEBRIDGE_KMJ_MODELFABRIC_TOKEN",
  "model": "modelfabric-auto",
  "maxTokens": 1024,
  "timeoutSeconds": 90,
  "recipes": {
    "pilot": {
      "verifyGate": "fast_check",
      "paths": ["src/example.js", "tests/example.test.js"],
      "contextPaths": ["src/example.js", "tests/example.test.js"]
    }
  }
}
```

Replace both example files with exact, existing tracked text files reviewed for
cloud transfer. Inspect the actual named gate command and arguments; only set
`autopilotCodingSafe: true` for a non-destructive independent verifier.
Require executable entitlement, a clean exact-head worktree, and available
capacity. Back up the existing protected config, validate the candidate against
the installed signed schema and stage only after the owner has approved the
recipe and source scope. Do not restart a busy agent; use the job-drained
activation path and preserve the previous config for rollback.

## First real coding task

The worker recognizes only keys of the form
`auto-code:pilot:FULL_40_CHARACTER_SOURCE_SHA`. Use the exact current source
HEAD, not the release metadata merge SHA unless that is actually checked out.
A generic roadmap task does not become an executable coding job. Start with a
small reviewable existing-file patch objective, not production deployment or an
unbounded roadmap. A request-specific native admission ticket must bind the
request to the zero-price route with available quota. Missing or expired
admission, token revocation, or unavailable capacity means no inference.
Never switch to a paid provider, local model or legacy router to recover.

Read back the actual worker runtime and scoped cached admission status, the
lease, exact SHA, model receipt, independent gate result and patch digest.
Cached admission is not proof of successful generation. Require the
VERIFIED_PATCH_AWAITING_REVIEW candidate and an independently reviewed result;
do not publish it automatically. Check restart recovery without replaying a
previous inference. Until all this is evidenced, autonomous coding is unproven.

For rollback, drain jobs and restore the previous protected project
configuration and service credential setup via the authorized operator.
Revoke the dedicated token through the owner panel if no longer needed.
Do not change the shared checkout, production gateway, other project services
or signing custody as part of coding activation.
