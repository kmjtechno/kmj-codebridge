# Restricted CodeBridge Supervisor

The CodeBridge Supervisor is the local privileged maintenance boundary for 24×7 recovery. It is deliberately smaller than a shell and does not accept arbitrary commands, service names, paths, environment variables or executables.

## Security boundary

The only recognized services are:

- `agent` → `kmj-codebridge-agent.service`
- `gateway` → `kmj-codebridge-gateway.service`

The only recognized configuration files are the fixed CodeBridge paths under `/etc/kmj-codebridge`. Callers cannot supply a filesystem path.

Initial operations:

- `status` — bounded systemd state for one allowlisted CodeBridge service
- `logs` — at most 200 journal lines, passed through CodeBridge redaction
- `config_validate` — schema validation only; config contents and credentials are never returned
- `restart` — schedules restart of one allowlisted CodeBridge service after the acknowledgement is sent
- `disk_space` — fixed CodeBridge state filesystem, with no caller-selected path

The agent exposes these through MCP as read operations except restart, which requires the existing `execute` permission.

## IPC

Linux uses a Unix-domain socket. The production client accepts exactly:

`/run/kmj-codebridge/supervisor.sock`

A caller cannot redirect the agent to another local socket. The server protocol is one bounded JSON request and one bounded JSON response per connection. There is no shell command field.

The server supports systemd socket activation through inherited file descriptor 3. When socket-activated it can exit after an idle window; systemd keeps the listening socket and starts it again on demand, so the Supervisor consumes no long-running CPU while unused.

## One-click installer integration

The VPS installer now provisions the Supervisor as a systemd socket-activated service:

- `kmj-codebridge-supervisor.socket` owns the fixed Unix socket.
- The socket file is `0600` and owned by the CodeBridge agent service user/group.
- The parent socket directory is created with traversal-only permissions for non-owners.
- `kmj-codebridge-supervisor.service` runs as root only when the socket is used and exits after the Supervisor idle window.
- The Supervisor service is hardened with `NoNewPrivileges`, strict filesystem protection, kernel/control-group protection, `RestrictSUIDSGID`, `LockPersonality` and `AF_UNIX`-only address families.
- Existing agent configuration is migrated only to the one canonical Supervisor socket path. Any unexpected pre-existing Supervisor path causes the installer to fail closed.
- Agent and Supervisor unit files are backed up and restored together if installation or live verification fails.
- Installation completes only after the agent reconnects to the gateway and a local Supervisor status request confirms the agent service is active.

## Current boundary and remaining slices

The Supervisor foundation is implemented and installer-integrated. Signed release verification, immutable staging/activation and local rollback primitives are also implemented separately in the update/release-store modules.

Software update and rollback are **not yet exposed as Supervisor RPCs** because the privileged boundary must stay fail-closed rather than becoming a generic command path. Signed archive download/extraction and a dependency-injected health-checked activation/rollback orchestration core are now implemented and tested. Before update operations are enabled on production devices, CodeBridge still needs:

1. live production evidence for status/log/config/restart on the supported installer path;
2. configured signed-manifest/signature retrieval and release-signing key custody;
3. a concrete preflight implementation for the supported runtime environment;
4. allowlisted `update_check`, `update`, `rollback` and `release_history` RPCs wired only to the fixed updater/ReleaseStore/orchestrator primitives;
5. fixed Supervisor restart plus authenticated agent/gateway health probes on the live immutable runtime layout, including a fault-injection rollback drill.

Until that sequence is merged and live-tested, installer rerun is the supported repair/update path and the Supervisor must not accept caller-selected commands, paths, URLs or service names.

### Main Platform: stage gateway configuration diagnosis

On a host that runs `kmj-codebridge-gateway-stage.service`, `supervisor_config_validate(gateway)` selects the **sole active gateway unit first**. If it is the stage unit, it reads only the fixed `/etc/kmj-codebridge-stage/gateway.json` (not the legacy `/etc/kmj-codebridge/gateway.json`). The stage directory and config must be root-owned, non-symlink, not group/world writable; the config must be regular, single-linked, at most 1 MiB, and must retain the same device/inode after a no-follow open. No caller-supplied path, environment variable, systemd ExecStart or process argument can redirect this read. Missing, untrusted, ambiguous or malformed state fails closed with bounded error codes.

A valid stage result includes `scope=FIXED_STAGE_FILE_SCHEMA_ONLY`, `runtimeConfigAttested=false`, and `signedRuntimeAttested=false`. It proves **only that the fixed protected file passes schema validation**; it does not prove the running gateway consumed that file, has working GitHub write permission, or matches a signed release. Live runtime binding, owner-signed canary and rollback still require separate operator-attested evidence. Neither the gateway credential nor its parsed content is returned.

## Development-only privileged broker: first fail-closed slice (2026-10-27)

The new `supervisor_development_privilege_status` tool is a **read-only**
readiness inventory for the exact `kmj-elite-main-platform` device and
`kmj-main-platform` project. It requests only `development_privilege_status`
from the existing root-owned Unix-socket Supervisor. No caller-supplied
argument other than the already enrolled device/project identifiers is accepted.
The Supervisor checks only these fixed units:

- `kmj-codebridge-kmj-main-platform.service` — existing project agent
- `kmj-codebridge-auto-update.service` — signed updater availability
- `kmj-codebridge-development-ci.service` — reserved future non-root development runner

Only `LoadState=loaded` counts as installed; masked, malformed, unknown and absent states fail closed. Root-owned unit/hash attestation is reported separately from `developmentWorkerReady=false` and `signedUpdaterVerified=false`. A loaded unit is not evidence of a running coding worker or signed updater. Fixed probe start still requires separate explicit approval and a valid root-owned attestation.

This status response always sets `unrestrictedRoot=false`,
`projectCodeRunsAsRoot=false` and `productionReleaseApproved=false`.
`brokerStartAuthorized` is true only when the fixed root-owned, hash-pinned
non-root probe attestation succeeds; it never authorizes arbitrary root
commands or a production release. A systemd
unit being _installed_ is not evidence that an autonomous coding model or
worker has actually run. The CloudOS-only Supervisor explicitly rejects the
Main Platform operation.

### Remaining implementation / independent gates (NOT activated by this PR)

1. Admin-reviewed, exact-hash signed root-owned unit, helper and executable
   must be installed on the enrolled VPS. No helper or dependency may be
   modifiable by the CodeBridge agent or a GitHub checkout.
2. If a privileged operation is genuinely needed, expose a **separate,
   typed, project-specific command profile** that can only provision or
   inspect an allowlisted development sandbox. No arbitrary `sudo`, shell,
   cwd, path, environment, service name, URL, port or caller-provided script.
   Code from GitHub (including install hooks) must run **as an unprivileged
   user** in a constrained, disposable, exact-SHA worktree—not within the root
   Supervisor process.
3. Validate systemd unit metadata, root ownership, immutable helper hash,
   absence of writable drop-ins, effective service user, sandbox settings,
   task lease/idempotency, resource quotas, audit receipts, cancellation,
   revocation and restart/fault-injection rollback.
4. Install the separately signed CodeBridge agent candidate with canary +
   rollback; verify new MCP tool publication and actual tool call in an
   authorized client. The existing stable agent must remain available until
   independent acceptance succeeds.
5. Connect an explicitly consented local/free inference provider, activate a
   real durable autonomous **coding** worker, and demonstrate GitHub issue →
   lease → detached worktree patch → tests → reviewable PR → restart/resume.
   A queue, a model planning result, or a status probe is **not** execution.
6. Continue to require distinct owner-signed approvals for production
   deploys, database writes, backup restore, DNS, SSH/firewall changes,
   credentials, payments, licenses and destructive operations. Don't rewrite
   old signed approval manifests to match a new release.

No bypass of signed CodeBridge license limits, no new paid inference and no
unverified 'live' claims. Until all gates complete, the root development
executor must remain **disabled**.

### Fixed read-only offsite backup diagnostic

`supervisor_main_platform_offsite_diagnostic` (op `main_platform_offsite_diagnostic`) runs
**only** the root-owned Main Platform diagnostic
`/usr/local/libexec/kmj-main-platform-diagnose-offsite-backup-unit-20261029.sh`
(byte-identical to kmj-main-platform `scripts/operations/diagnose-offsite-backup-unit-20261029.sh`,
SHA-256 pinned in `src/offsite-diagnostic-policy.js`). It requires the exact
`RUN_FIXED_READONLY_OFFSITE_DIAGNOSTIC` confirmation, the enrolled
`kmj-elite-main-platform/kmj-main-platform` scope, the normal `execute` grant and
`PRIVILEGED` risk approval. No path, argument, environment, unit or shell can be supplied.

Before running, the Supervisor requires `/usr/local/libexec` and the script to be root-owned,
non-symlink, single-link, not group/world-writable, not setuid/setgid, owner-executable and
bounded in size, and the file bytes to match the pinned SHA-256; the hash is re-checked after the
run. The child's stdout is parsed against a strict allowlist (exact keys, each once, anchored value
patterns, `mutations=NONE`, `raw_output_suppressed=yes`, fixed unit). Extra keys, duplicates,
raw journal text or inconsistent claims fail closed; child stderr and exit details are never
returned. A classified `failure_class` is accepted only for an exact-invocation, exit-255 failure;
otherwise the class stays `UNKNOWN_EXIT_255_NEEDS_LOG`.

The result never claims backup validity, restore, offsite transfer or release approval, and the
call never starts or restarts any unit and never touches the backup timer. If the Supervisor's own
systemd sandbox cannot read the journal, the script reports `journal_scope=UNAVAILABLE`.

Root-operator installation (not performed by CodeBridge):
`install -o root -g root -m 0750 diagnose-offsite-backup-unit-20261029.sh /usr/local/libexec/kmj-main-platform-diagnose-offsite-backup-unit-20261029.sh`
then verify `sha256sum` equals the pin. A live run needs that installation and owner approval;
none is claimed here.

### Root-owned non-root probe attestation — implementation phase 2

The separate `supervisor_development_ci_start` action requires an explicit
`START_PINNED_NONROOT_DEV_PROBE` confirmation, the enrolled
`kmj-elite-main-platform/kmj-main-platform` scope, the normal CodeBridge
`execute` grant, and `PRIVILEGED` risk classification. It starts **only**
`kmj-codebridge-development-ci.service`—not a generic shell, unit,
repository, URL, path, Git SHA or arbitrary command.

The Supervisor checks the **effective** systemd user, hardening flags,
immutable unit path, no drop-ins, installed unit bytes, root ownership and
SHA-256 of the exact installed helper. These checks are repeated **after**
its acknowledgement before it asks systemd to start the fixed unit. Any
stale, missing, changed, running or unsafe unit fails closed.

The committed `scripts/production/kmj-codebridge-development-ci.service`
and `scripts/production/kmj-codebridge-dev-probe.py` are installer **inputs**,
not an installer. They are not copied into privileged paths by the MCP
agent, a GitHub merge, or this pull request. An administrator must independently
review, sign and install them in root-controlled paths with a dedicated
`kmjdevci` non-root account and private state directory. Existing production
services, root login, firewall, backup and protected release are unaffected.

The Python helper performs only a no-network, read-only `git rev-parse`
on the fixed Main Platform checkout and emits one bounded revision receipt;
it does **not** edit source, install packages, execute project hooks, run
AI inference or demonstrate autonomous coding. A future independent
lease-bound coding worker must use isolated project worktrees and must never
inherit the Supervisor's root credentials or cross the protected release gate.

The installed KMJ-elite agent still needs a signed canary/rollback upgrade
and live root-unit attestation before any new MCP tool is available there.
Do not mark this feature live based solely on source CI or the helper's
presence in GitHub.
