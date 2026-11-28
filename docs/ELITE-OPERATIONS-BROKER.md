# Elite Operations Broker — readiness contract

The initial source contract is advisory only. It cannot authorize a command,
authenticate a receipt, grant privileges, or activate any release. No new
privileged endpoint or tool registration is introduced in this change.

## Fixed scope

- Host: KMJ-elite; project: Main Platform. Google VPS remains CloudOS test-only.
- The existing staging supervisor operation is reused, not replaced.
- Every future privileged adapter must be independently reviewed, owner-installed
  and pinned by the root-controlled host. Use fixed operation IDs, not caller
  paths, executable names, SQL, shell text, environment or arbitrary units.
- Separate identities for application, database, backup and restore rehearsal.
  Never expose passwords, tokens, private signing keys or full logs to clients.
- Restore is rehearsal-only against an isolated disposable database. The
  production adapter must independently verify backup, restore, database
  isolation, authenticated QA and rollback evidence before any cutover.
- Any actual execution requires a revocable, expiring owner grant for the exact
  operation and target scope, authenticated at the host. Independently recheck
  exact SHA, existing live identity, root pins and evidence under a durable
  single-flight lease immediately before execution. Persist an idempotent
  receipt and independently verify the result; an ACK is not PASS.
- Keep signing separate under the existing owner signer and its sequence policy.
  Warn before exhaustion or expiry; only the owner can authorize renewal.
- Never infer trusted host evidence from a caller-supplied object. The planner
  merely detects inconsistent, stale or missing observation metadata. A host
  adapter must validate actual provenance, receipt type, digest, resource
  identity and retention; an untrusted caller can manufacture metadata.
- No owner grant, root adapter, durable execution ledger, live deployment,
  authenticated receipt collector or dashboard action is installed by this PR.

The catalog lists toolkit installation, database isolation, backup, restore
rehearsal, staging preparation, staging activation, authenticated QA, production
deployment and production readback. Keep production activation separate from
readback and distinguish pending or unknown evidence from completed operations.

## Independent readback and policy warnings

The read-only status interpreter combines existing staging, production and
maintenance supervisor observations. A ready production adapter must not
override staging identity mismatch, production drift, or missing backup and
restore evidence. Even complete metadata does not prove authenticated QA
or authorize deployment. The caller must collect fresh authenticated observations.

The signing-policy status helper warns when five or fewer sequences remain
or expiry is within seven days. It never modifies the owner policy, renews
consent or authorizes signing. These are advisory defaults, not new signing
policy limits. Wire these helpers to an authorized backend before displaying
live status; the functions alone are not an installed broker or alert service.
