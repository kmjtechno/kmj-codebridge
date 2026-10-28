# Isolated non-root Git source: admission contract (SOURCE ONLY)

## Why

On 2026-10-28 the owner-run KMJ-elite diagnostic for issue
[#652](https://github.com/kmjtechno/kmj-codebridge/issues/652) confirmed
`PACK_FILES=SOME_UNREADABLE` to the dedicated `kmjdevci` identity.
The fixed installed one-shot helper still exits 3. Readability of the shared
Main Platform `.git/HEAD` **does not** imply readable commit objects.

**Do not** broadly change permissions or ownership of
`/srv/kmj-codebridge-projects/kmj-main-platform`, globally whitelist its
Git ownership, use shared credentials, or execute the unreviewed
`work/qa/KMJ_CB_GIT_READONLY_ACL_REPAIR_20261028.py` prototype. Giving
access to Git pack files may expose the checkout's full history, not only the
current revision.

## Future isolated source candidate

`scripts/production/attest-isolated-development-source.mjs` provides a
purely **read-only** source consistency check for an **independently prepared**
`/var/lib/kmj-codebridge-development-ci/source` checkout. It does not
install, fetch, clone, copy, chown, chmod, grant ACLs, configure systemd, or
run autonomously. In particular:

- The owner-reviewed **exact SHA-1 commit** must be supplied from a separate,
  authenticated release approval; an unspecified HEAD is never accepted.
- The effective process identity must be exactly `kmjdevci`, non-root.
- `/var` and `/var/lib` must be root-owned, non-writable by group/others.
  The private worker state, source, `.git`, `objects` and `refs` must be
  worker-owned, no symlinks, and inaccessible to group/others.
- Four fixed, offline `/usr/bin/git` read operations check HEAD, the pinned
  commit's object type, commit identity and HEAD stability; they use no
  arbitrary source path, network, shell, hooks or `safe.directory` exception.
- The result is a bounded status only. Even `PINNED_SOURCE_READABLE` means
  **diagnostic consistency**, not an approved signed release, source
  provenance, protected production deployment or live AI coding.

## Separate approval gates (not satisfied by this change)

1. Review a dedicated source provisioner, its per-repository authorization,
   provenance/retention/privacy limits, resource budget, no embedded secrets,
   durable audit log and atomic rollback. **Do not copy existing protected
   Git object packs or the entire repository history by default.**
2. Prove the provisioned source and approved commit match the signed owner
   manifest before any source use. A caller-supplied SHA string alone is
   insufficient authorization.
3. Independently review and sign an **updated** fixed service/helper candidate
   to use this isolated source, preserving an exact checksum and systemd
   sandbox attestation. The **existing** installed helper is still pinned to
   the old, shared checkout. Replacing it in place without signed canary and
   rollback is forbidden.
4. Owner-approved canary activation, non-root systemd probe, rollback/fault
   injection and verified restart/recovery are required. Preserve
   Main Platform production, existing CodeBridge agent/gateway, firewall,
   SSH, DNS, credentials and paid-service constraints.
5. Finally, opt into a free local model, lease-bound detached development
   worktrees, tests and independent PR review; demonstrate a real patch/test
   cycle and restart/resume. Never claim 24x7 coding live based on this
   diagnostic's result or a GitHub CI green badge alone.

No commands in this document are authorization to install or execute as root.
