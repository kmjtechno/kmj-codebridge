# Elite bounded owner policy renewal

The owner authorized increasing the existing sequence cap to 100, with no
extension of its original expiry. This reviewed utility is an owner-operated
maintenance action, not a new CodeBridge privilege, background signer or
automatic renewal. It never reads a private key, signs, modifies branch
protection, changes the running service or performs deployment.

Review the source and exact-head CI first. Install only from an independently
approved immutable revision into a root-controlled location, then invoke with
Python isolated mode as the owner on KMJ-elite. Default mode is inspection:
it prints the current cap, target cap and SHA-256 of the current protected
policy, not the policy contents. Apply requires the exact inspection digest
and the explicit confirmation `OWNER_APPROVES_CAP_100_KEEP_EXPIRY`.

The utility drops privileges to the existing dedicated signer before
touching its policy. It requires existing private directories, checks the
fixed signer policy schema and scope, acquires the existing signing lock,
preserves a create-only protected backup, changes only the cap, and performs
atomic replacement and readback. Existing signer source and pins remain
unchanged. A busy or stale lock is not removed. A digest mismatch, expired
policy or unexpected policy layout blocks renewal. No new key is enrolled.

After successful owner renewal, use the existing exact-main signed release
preflight; all CI, review, key and signed-history checks still apply. A
successful cap renewal is not a signed release or a deployment.

Finite sequence limits and policy expiry are deliberate security controls:
warn before either is reached and renew with explicit owner authorization.
No automatic infinite renewal or policy expiry extension is authorized.
