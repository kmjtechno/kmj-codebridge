# Security boundaries — developer preview

Do not expose this preview to untrusted users or use it on production infrastructure
before a dedicated security review and the production gates in docs/STATUS.md.

## Controls implemented

Hashed bearer tokens at the gateway; separate user/agent credentials; per-tenant,
device and project checks; host and origin allowlists; bounded requests and queues;
fixed administrator-defined commands; no shell interpolation; denylisted sensitive
paths; symlink/hardlink exclusions; bounded UTF-8 reads; expected-hash file replacement;
bounded logs and credential-pattern redaction; signed entitlement verification.

## What these controls do not promise

- Path validation is not a kernel sandbox. An untrusted local process can race filesystem
  operations. Use an isolated account and filesystem/container boundary for hostile code.
- Quality gates execute code with the agent account's OS rights. Configure only trusted
  gates, and use separate worker VMs/containers for untrusted repositories.
- Redaction is defense-in-depth, not proof arbitrary output contains no secrets. Never
  put sensitive content in the authorized project or execute commands that print it.
- A local administrator can alter binaries, clocks and state. Signed tokens alone do
  not make an agent tamper-proof.
- Bearer credentials need out-of-band provisioning and rotation. OAuth and device-key
  enrollment are required before general public customer onboarding.
- The job journal is local and bounded to 1,000 records. Protect it from tampering.
  Do not delete idempotency records while a caller could retry an old request.
- Terminal job output is persisted. Output during a crash may be lost. Stale running
  records become interrupted; processes are never silently relaunched.
- State lock removal after a crash requires an operator to first verify no agent or
  associated jobs remain. PID alone is not adequate proof.
- CPU/RAM hard limits, durable gateway queueing, high availability, signed installers
  and tenant-wide quota enforcement are not yet implemented.

Configuration, state and entitlement files must be outside authorized project roots.
Do not mount Docker sockets, cloud metadata credentials or host root into a worker.
Public issue reports must exclude secrets. Report sensitive findings privately to
KMJ TECHNO through an independently verified contact before public disclosure.
