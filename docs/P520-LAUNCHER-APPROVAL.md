# P520 local llama.cpp: protected launcher and approval gate

**Status: design and source-only cryptographic preflight. No live activation.**

The P520 owner has already executed a V2 read-only process/model check. It observed a SHA-256-verified Qwen3.5 9B GGUF, the pinned llama-server binary, loopback 127.0.0.1:20145, stable process PID/creation details and healthy localhost model self-report. Its result was `PRELIMINARY_READONLY_OWNER_APPROVAL_PENDING`, **not** protected launcher or publisher attestation. The executable is `Authenticode: NotSigned`. A binary digest pins file content at observation time but does not establish who published it.

The draft PR #734 adds `src/p520-launcher-approval.js`: a **non-activating** Ed25519 approval-envelope verifier. Its successful result is still `ownerAttested:false, mayEnableInference:false`. It is not wired to `src/agent.js` or any Windows service.

## Trusted launch prerequisites

1. Owner/operator approves an explicit protected Windows launcher/supervisor identity. The launcher must be running and independently reviewed, with a narrowly scoped identity and secure token/file ACLs. Do **not** create a new Windows task over an existing active agent, grant arbitrary commands, disable UAC/Defender or modify another device.
2. From that protected process (not user chat, localhost API self-report or a JSON file in a user-writeable directory), observe the current **unique** PID, creation time, fixed server executable and pinned SHA-256, GGUF path and pinned SHA-256, exact model argument, fixed host and port, and listener ownership. Refuse junctions, symlinks, redirected paths and untrusted writable ancestors. Repeat binding immediately before any private prompt, and fail if PID/process identity, file identity or listening socket changes.
3. Independently provision an owner-controlled Ed25519 approval signing key. Do not generate it from an MCP request, print/export a private key into chat/CI/source, or accept a public key supplied by the approval document. Pin the **SHA-256 of the SPKI DER** for the approved public key in protected operator policy.
4. The approval envelope is canonicalized to one known schema and bound to the exact P520 device, hostname, model/binary SHA-256, model/executable absolute paths, localhost port, PID, process creation time, issued and expiry times (maximum five minutes), and a 128-bit nonce. Reject unknown fields, replayed nonces, unexpected runtimes and expired grants.
5. A protected Windows Supervisor must verify signature, file/ACL provenance, currently running PID and exact listener **in one authority-controlled transaction**, bind the current connection to that process and report fresh, scoped attestation. If any element is missing or ambiguous, refuse the prompt.
6. Only after owner-reviewed Windows negative tests, actual protected launcher evidence, safe deployment/rollback and exact-head CI should a separate reviewed change consider passing `ownerAttested:true` to `useP520LlamaCpp`. A feature flag alone must never enable local inference.

## What the current helper actually guarantees

`p520LauncherApprovalBytes(manifest)` enforces exact fields, pinned P520 identity/hash, safe Windows drive paths, strict ISO timestamps and five-minute maximum duration. `verifyP520LauncherApproval` checks a pinned SPKI fingerprint, Ed25519 signature, issue/expiry and claimed process fields. **It deliberately returns `mayEnableInference:false` even when signature verification succeeds** because it has no protected Windows process/ACL witness. Caller-provided `observed` is not trusted.

**Replay boundary:** the signed preflight validates nonce format but does not consume a nonce. The separate source-only `consumeP520ApprovalNonce` primitive in `src/p520-approval-nonce-ledger.js` can atomically claim one nonce in an *existing* filesystem directory with exclusive create, keep any partial claim, and reject normal process-restart replay. Its unit tests cover concurrent-file exclusivity behavior, reboot-like process restart via a child process, symlinked root, expired grants, corrupted preexisting files and injected storage errors. **This is NOT yet wired to a trusted Windows Supervisor, cannot prove protected ACLs or publisher identity, and cannot guarantee directory-entry durability against a sudden power loss.** The future owner-protected Windows Supervisor must independently provision and validate the ACL-restricted directory, control exclusive access to signing/consumption, protect nonce claims against deletion, provide a stable process witness and fail closed on abnormal storage errors. Never interpret `signatureVerified:true` or `recorded:true` as permission to expose private prompts.

Owner public key input is size-bounded before cryptographic parsing; the verifier still requires an independently protected SPKI fingerprint and always denies inference activation.

Test fixture signing keys are ephemeral and exist only inside Node tests. They are never stored in the repository, the user's PC or production. The preflight does not start a server, open a listener, modify model files, install a certificate or infer that `NotSigned` means compromise.

## Next independently verifiable gate

The current CodeBridge P520 device has zero admin-approved command profiles and Windows Supervisor is unavailable. Keep PR #734 draft/unmerged and keep the active 9B server and both CodeBridge/OmniDesk agents untouched. Implement a protected launcher and its narrowly authorized observation API, with negative ACL/process-swap/replay tests, only through an explicitly approved owner-safe rollout. No additional provider spend or new models.
