# Safe CodeBridge supervisor recovery from MCP

The legacy KMJ-elite Main Platform agent can remain online while its privileged
supervisor socket is missing. A normal project MCP connection cannot grant
itself Linux root permissions. **Do not promote the kmjcode-writable development
checkout into a privileged service.**

## New bounded tools

- `bootstrap_supervisor_status(device, project)` is a read-only, fixed-host
  diagnostic that works even when `supervisor_*` is unavailable. It accepts
  only the already authorized project `kmj-main-platform`. It reports
  preinstalled unit state, socket presence and whether the fixed root-owned
  helper is trusted. It never reveals enrollment material or shell output.
- `bootstrap_supervisor_start(device, project, confirmation)` accepts only
  `START_APPROVED_CODEBRIDGE_SUPERVISOR`, requires CodeBridge execute access
  and uses **one fixed** `sudo -n` call to the installed root-owned helper.
  It cannot accept a command, path, SHA, service name, environment or argument.
  It fails closed when sudo permissions or the trusted helper are missing.

The helper only enables/starts
`kmj-codebridge-supervisor.socket` **after** verifying an already installed
fixed agent, socket and privileged supervisor service and an immutable,
root-owned `/opt/kmj-codebridge-supervisor-stage/<SHA>` runtime. It never
installs new Linux privileges, fetches code or touches production applications.

## Why first-time root trust is unavoidable

If the original socket **and root service do not exist**, there is no trusted
privileged endpoint through which an unprivileged MCP call can create them.
A root operator must first use the [pinned-archive bootstrap](MAIN-PLATFORM-PRODUCTION-CONTROL.md)
on the authorized KMJ-elite console. That audited installer now also places
the fixed activation helper at
`/usr/local/libexec/kmj-codebridge/activate-supervisor-socket-approved`.
It **does not** change sudoers, OAuth, agent enrollment, production symlinks or
any database.

For later optional one-click activation, the owner may separately permit
**only that exact no-argument helper**, to the exact verified user of the
existing agent unit. Do not use a wildcard, allow `bash`, allow `systemctl`
or grant blanket NOPASSWD sudo. A sudoers rule, after owner review, has this
shape (the trailing `""` enforces zero arguments):

```sudoers
<verified-agent-service-user> ALL=(root) NOPASSWD: /usr/local/libexec/kmj-codebridge/activate-supervisor-socket-approved ""
```

Check it with `visudo -cf` before use; obtain the service user with
`systemctl show kmj-codebridge-kmj-main-platform.service -p User --value`.
Use root ownership and mode `0440` for the sudoers file. Never copy the
template literally without replacing the verified service user.

After installing a version containing these new tools on **both** gateway
and agent, query `bootstrap_supervisor_status`. If the fixed units and
owner-delegated helper are ready, invoke `bootstrap_supervisor_start` with
the exact confirmation string. **Accepted is not verified.** Require
`socketVerified: true`, then successfully call an authenticated
`supervisor_project_status` from the connected account. Check unit logs and
perform live client smoke tests before claiming production readiness.

## Failure and rollback rules

- `BOOTSTRAP_FIXED_HOST_ONLY`: refused outside Linux hostname KMJ-elite.
- `BOOTSTRAP_AGENT_UNIT_MISSING` or `BOOTSTRAP_ROOT_UNITS_MISSING`:
  initial operator bootstrap is required.
- `BOOTSTRAP_OPERATOR_HELPER_NOT_PROVISIONED`: no trusted helper; operator
  must inspect and install it from the pinned source.
- `BOOTSTRAP_OPERATOR_AUTH_REQUIRED`: root helper is present, but the
  noninteractive exact sudo call is not authorized or failed.
- `SOCKET_NOT_VERIFIED`: the helper returned but socket presence could not
  be independently observed; do not report PASS.

This recovery flow never deploys KMJ Main Platform, restarts the enrolled
agent, fabricates backup evidence, repairs a production database, or merges
a PR. Review and test all privileged changes before enabling owner delegation.
