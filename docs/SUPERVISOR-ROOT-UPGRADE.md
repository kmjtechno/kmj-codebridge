# KMJ-elite protected supervisor upgrade

The initial bootstrap can create the root-owned supervisor socket successfully
while the live privileged service still runs the older CodeBridge revision.
A valid socket and `supervisor_device_status` response **do not** prove that
`supervisor_project_status` can read the registered Main Platform enrollment.

On the old revision, project status uses the generic
`/etc/kmj-codebridge/agent.json` file. The existing Main Platform agent uses
`/etc/kmj-codebridge-main-platform/agent.json`. The required fix is in the
reviewed supervisor source, **not** a copied or symlinked secret-bearing file.

## Operator-only pinned upgrade

`scripts/production/upgrade-pinned-supervisor-runtime.sh` is the root-only
upgrade path. It must be invoked from a **clean, root-owned, pinned Git SHA**
that contains the verified fixes, and the operator sets
`KMJ_APPROVED_CODEBRIDGE_SHA` to that exact reviewed commit. Do not run
from the writable CodeBridge development agent checkout.

The script checks the existing immutable runtime and exact systemd ExecStart,
uses the existing locked, lifecycle-scripts-disabled root staging procedure,
rejects unsafe Node/npm paths, and creates one new fixed
`50-kmj-pinned-runtime.conf` drop-in only if no prior drop-in of that name
exists. It refuses to change the unit while the supervisor service is active,
temporarily stops the socket to prevent concurrent activation, validates the
new effective ExecStart, then starts the socket again. On error after mutation,
it removes the new drop-in, reloads systemd and attempts to restore the socket.
It never changes the enrolled agent, tokens, sudoers, DNS, database, production
release symlinks or application services.

**Root execution and source selection are separate operator approvals.** This
command is only safe to run after the exact commit's checks and security review
have passed. Do not substitute `main` or an unreviewed draft PR branch.
Rollback on failure is an attempted recovery, not evidence of an authenticated
working service.

After the script prints `SUPERVISOR_UPGRADE_SOCKET_READY=1`, verify all of:

1. Authenticated `supervisor_device_status` returns the new expected Node.
2. Authenticated `supervisor_project_status` for project
   `kmj-main-platform` returns the project status instead of
   `SUPERVISOR_CONFIG_INVALID`.
3. Authenticated `supervisor_config_validate` returns
   `{ "service": "agent", "valid": true }`.
4. Confirm the active root stage SHA and fixed socket service status.
5. Run the remaining CodeBridge release gates on their own authorized devices.

Failure to pass any of these is a **release blocker**. A source-only CI green
PR must not be represented as a live deployment or as completed hardware
acceptance.
