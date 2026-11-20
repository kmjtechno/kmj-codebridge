# KMJ-elite: Supervisor read access to the staging pointer (owner one-click)

`kmj-codebridge-supervisor.service` runs with `ProtectHome=tmpfs` and binds only
`/home/kmjprod`, so the staging release symlink
`/home/kmjstage/htdocs/staging.kmjtechno.com` is invisible and the staging policy
reports `STAGING_POINTER_UNVERIFIED`.

`scripts/production/owner_elite_supervisor_staging_pointer_dropin.py` adds one
drop-in with exactly `BindReadOnlyPaths=-/home/kmjstage/htdocs` (read-only, only
the directory holding the symlink; the policy does `lstat`/`readlink` on it).

- Dry run by default; `--apply` needs root on KMJ-elite and refuses while a
  guarded release unit is running.
- The Supervisor is socket-activated, so the installer only runs `daemon-reload`
  (no restart, no tool outage); the next request starts the service with the new
  mount. It verifies the effective unit lists the bind path and otherwise removes
  the drop-in and reloads (automatic rollback).
- Touches no application, database, release pointer, staging/production unit,
  DNS, network or secret.

This only makes the pointer verifiable. Staging status also needs a fresh staging
approval for the next release; this tool does not write one.
