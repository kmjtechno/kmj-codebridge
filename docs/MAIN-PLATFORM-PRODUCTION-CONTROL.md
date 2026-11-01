# KMJ Main Platform Production Command Control — staged activation, not arbitrary shell

## Why this exists

The verified Main Platform Control Center UI was merged to main as
`f21f6f36d9cbc3067edb7107b1a7517d862183ad`, but KMJ-elite still
resolved `/home/kmjprod/current` to
`/home/kmjprod/releases/commerce-3315f2a-20261009`. Nginx and PHP 8.4
were active, and the frontend manifest existed. No data in that read-only
probe proves the new UI has been deployed.

The existing CodeBridge agent has `kmj-main-platform` bound to an authorized
**development** checkout. Its `supervisor_*` calls report
`SUPERVISOR_UNAVAILABLE` until a privileged, socket-activated supervisor is
installed and attached to the agent; writing additional source code does
not by itself create a VPS command channel.

## MCP operations

- `supervisor_main_platform_production_status(device, project)`: fixed
  no-arguments inventory, scoped to project `kmj-main-platform`; reports only
  the current release basename, approved full SHA, expected old release,
  operator-installed unit status and Nginx/PHP health. No credentials, paths,
  shell output or file contents.
- `supervisor_main_platform_production_activate(device, project,
approvedSha, expectedCurrentRelease, confirmation)`: explicit execute-only,
  owner-approved activation. `confirmation` must equal
  `ACTIVATE_APPROVED_PRODUCTION_RELEASE`. Input must match the root-owned
  protected approval file and live old pointer. **Accepted does not mean
  deployed**; check the fixed systemd service and actual live UI afterwards.

No arbitrary command strings, shell, project path, unit names, Git ref,
environment variables or user-supplied executable arguments are accepted.
Owner must review which CodeBridge users receive `execute` for production.

## Upload and configuration continuity (enforced before and after the switch)

`storage/app` (customer uploads) and `.env` live inside each release tree. A freshly built
candidate has neither, so a bare pointer switch would still pass the login/icon health check
while every customer upload silently disappeared from the live site.

The activation controller therefore refuses to switch unless, for the candidate versus the
current release:

- `apps/platform/.env` is a regular, single-link, no-symlink file of at most 64 KiB with a
  **byte-identical SHA-256** (only equal/different is reported, never content);
- `apps/platform/storage` resolves to the **same real directory** (a shared-storage link) and
  contains `app/`. A copied tree is deliberately not accepted: a copy cannot be race-free against
  uploads arriving during the switch.

After the switch the same facts are read again through `/home/kmjprod/current` inside the
rollback-protected block; any difference triggers the existing verified rollback.

Failure categories: `CONTINUITY_ENV_MISSING`, `CONTINUITY_ENV_UNSAFE`, `CONTINUITY_ENV_DIFFERS`,
`CONTINUITY_STORAGE_MISSING`, `CONTINUITY_STORAGE_NOT_SHARED`, `CONTINUITY_LOST_AFTER_SWITCH`.

Owner preparation (not performed by this source change): before approving, make the candidate's
`apps/platform/storage` a link to the current release's real storage directory (preferably moved
to a location outside any release directory first, so pruning an old release cannot delete
uploads) and place the reviewed `.env` identically. This is production-adjacent work and needs the
owner's explicit approval and a fresh backup. Nothing here proves it has been done.

## Initial host bootstrap — one-time operator step

Only after reviewing this source on an authorized KMJ-elite console, as root,
run the checked-in installer (do not run a network-fetched `curl | bash`
one-liner).

Do **not** run the installer from a development checkout (for example
`/srv/kmj-codebridge-projects/kmj-codebridge`). It refuses any source outside a
root-owned, non-writable archive extraction under `/root` or `/tmp`, and it needs
`KMJ_APPROVED_CODEBRIDGE_SHA`. Use the pinned-archive procedure in the runbook below.

It only installs the **fixed inactive** unit and fixed root-owned script;
it cannot deploy by itself and does not create fake approvals or backups.
It also installs a narrowly scoped supervisor service drop-in if the
supervisor unit is already installed. The stock CodeBridge supervisor's
`ProtectHome=yes` conceals the live symlink even from root. The drop-in
uses `ProtectHome=tmpfs` plus a read-only bind of **only**
`/home/kmjprod`, retaining isolation of every other home. This follows
systemd's documented rule that bind mounts beneath a protected home must
use tmpfs rather than `ProtectHome=yes`. The installer never force-restarts
an active supervisor; after confirming it is idle, the operator must
restart its fixed socket/service through the guarded maintenance flow,
then verify the new `supervisor_main_platform_production_status` response.

It provisions a missing _restricted_ systemd supervisor socket and root
service only for the existing, trusted Main Platform agent installation. The
bootstrap checks the fixed KMJ-elite hostname, registered service user, exact
agent ExecStart/runtime, protected 0600 enrollment configuration, and fixed
/run/kmj-codebridge/supervisor.sock. The owner's observed legacy Main Platform
agent runs from `/srv/kmj-codebridge-projects/kmj-codebridge` as `kmjcode`
and is legitimately writable by that unprivileged user. It must **never**
be imported by a privileged root process.

The updated installer stages an independent root-owned runtime from a
**trusted, root-extracted GitHub commit archive** into
`/opt/kmj-codebridge-supervisor-stage/<approved full SHA>`. It requires
`KMJ_APPROVED_CODEBRIDGE_SHA` to be a 40-digit lowercase hex revision
matching the archive explicitly approved by the owner; copies only source and
lockfile, installs locked production npm dependencies with lifecycle scripts
disabled, checks the Node runtime and rejects writable or escaping files.
Only the staged runtime is referenced by the root supervisor's ExecStart.
If an old staged runtime exists, its recorded source hashes must match and
its permissions must remain protected.

**Owner bootstrap invocation** from the pinned archive must supply the
approved commit ID to the root installer, for example:

### Runbook: pinned-archive bootstrap (owner, as root on KMJ-elite)

```bash
sudo -i
# 1. A root-only working directory (the installer rejects a group/world-writable parent).
install -d -m 0700 /root/kmj-approved && cd /root/kmj-approved

# 2. The exact commit you reviewed, as a full 40-character SHA. Use the current reviewed
#    main commit; do not reuse an old value.
SHA="<exact-reviewed-40-character-sha>"

# 3. Download that commit's archive and record its checksum. Compare the checksum with a
#    second, independent download (for example from your own computer) before continuing.
curl -fsSLo codebridge.tar.gz "https://github.com/kmjtechno/kmj-codebridge/archive/${SHA}.tar.gz"
sha256sum codebridge.tar.gz

# 4. Extract as root and force root ownership regardless of what the archive records.
tar --no-same-owner --no-same-permissions -xzf codebridge.tar.gz
cd "kmj-codebridge-${SHA}"

# 5. Run the installer from this root-owned extraction, passing the same approved SHA.
KMJ_APPROVED_CODEBRIDGE_SHA="${SHA}" bash scripts/production/install-main-platform-control.sh
```

The installer only verifies that the extraction is root-owned and non-writable and that
`KMJ_APPROVED_CODEBRIDGE_SHA` has the right shape; the SHA is the owner's approval label and is
not recomputed from the files. That is why step 3 (independent checksum comparison) matters.
Success prints `SUPERVISOR_STAGE_READY=1` and the staged runtime path. Afterwards, from the
connected device, verify `supervisor_project_status` before using any other supervisor tool.

No runtime staging or privileged service operation is initiated by
CodeBridge chat tools until this first trusted root action succeeds. It resolves the existing agent location from the effective systemd `WorkingDirectory` instead of guessing: accepted layouts include the observed unprivileged
`/srv/kmj-codebridge-projects/kmj-codebridge` (owned by `kmjcode`), the original
`/opt/kmj-codebridge-agent`, and the separate root-owned immutable
`/opt/kmj-codebridge-main-platform-stage/<40-character SHA>` created by the
guarded Main Platform refresh flow. For staged agents it validates the fixed
stage directory, immutable manifest identity and all root-owned imported
code/dependencies. Root supervisor code is always isolated at
`/opt/kmj-codebridge-supervisor-stage/<approved full SHA>`.
The Node executable must match the existing unit's exact
`ExecStart` and an allowlisted root-owned interpreter target; unknown,
writable, symlink-escaped or caller-provided runtimes are refused. It refuses
unknown agent identities, writable imported packages or injected service
paths. It never restarts the agent, re-enrolls it, downloads code, changes
stored tokens/OAuth settings or deploys the website. Where the socket unit
already exists, it only enables/starts that fixed unit without overwriting
its operator-reviewed definition.

After a successful bootstrap, `kmj-codebridge-supervisor.socket` should be
**active**, while its socket-triggered privileged service can remain
**inactive until the first authorized request**. From the connected
`kmj-elite-main-platform` device, verify
`supervisor_project_status` and
`supervisor_main_platform_refresh_status` before using further controls.
If the agent still advertises old tools, invoke the fixed authorized agent
refresh path only when the updater and independent rollback checks permit.
An online agent is not proof the production command catalog has updated.

The CodeBridge agent must separately have the documented
`supervisorSocket=/run/kmj-codebridge/supervisor.sock` configured in its
protected enrollment. If missing, repair it with the existing guarded agent
installer/rebind flow, never by pasting a token into chat.

## Captured-client backup timer inventory (read-only compatibility)

An already-connected ChatGPT/Claude client may not expose a newer
`supervisor_main_platform_maintenance_status` tool in its captured catalog.
On **KMJ-elite only**, an already-authorized, writable
`kmj-elite-main-platform / kmj-main-platform` project can instead call the
existing `run_project_command` tool with
`command="main_platform_offsite_status"`, `variant="overview"` and a
nonempty idempotent `requestKey`.

The compatibility route invokes only the fixed privileged supervisor operation
`main_platform_maintenance_status` and returns allowlisted unit states for the
existing offsite-backup service/timer and health-check service. It refuses
unknown variants, worktree lanes, SHA overrides, wrong devices/projects and
missing supervisor. Although the inventory is classified `READ`,
`run_project_command` requires the existing `execute` feature to invoke it;
this does **not** grant any new shell or root operation.

**Never** interpret a successful timer/service result as proof the current
candidate was encrypted, copied to an independent host, decrypted, restored or
approved. The response hardcodes
`candidateEncryptedOffsiteVerified=false`,
`independentRestoreVerified=false`, `rollbackVerified=false`, and
`productionApprovalChanged=false`. The source patch does not change already
installed agents or privileged supervisors: installer update, deployment and
live-tool verification remain separate owner-approved operations. No backup
service is started and no private key, path, target URL, secret, environment
content or operator-selected process arguments can be requested.

## Prestage, verify backups and approve

The fixed service expects an **already prepared** immutable, clean release:

`/home/kmjprod/releases/platform-<first-12-characters-of-approved-SHA>`

It must have exact Git HEAD, clean tracked index, Laravel `artisan`,
`vendor/autoload.php`, built `public/build/manifest.json`, and official
KMJ CodeBridge icon. No `git pull`, `npm install`, `composer install`,
database migration or secret download happens inside the privileged unit.
Prepare in staging with a less-privileged service user and verify separately.

Before activation the operator must create a real, restorable backup of
the **current production database and required application data/config**,
and independently test restoration. Archive it at the fixed location
`/var/backups/kmj-platform/pre-deploy-<sha12>.tar.gz` (root-owned, no
group/world write). The witness
`/var/backups/kmj-platform/pre-deploy-<sha12>.json` must be root-owned,
single-linked, at most 4096 bytes, and contain exactly:

```json
{
  "approvedSha": "f21f6f36d9cbc3067edb7107b1a7517d862183ad",
  "currentRelease": "commerce-3315f2a-20261009",
  "backupSha256": "<64 lowercase hex characters from the actual archived backup>"
}
```

Likewise root-owned, mode 0600, single-linked
`/etc/kmj-codebridge/main-platform-production-release.json` must contain:

```json
{
  "approvedSha": "f21f6f36d9cbc3067edb7107b1a7517d862183ad",
  "expectedCurrentRelease": "commerce-3315f2a-20261009",
  "backupVerified": true,
  "rollbackVerified": true
}
```

These values must reflect **actual** evidence, not optimistic flags. Do
not create or set them to true before the backup and rollback have been
verified.

Before triggering, check `supervisor_main_platform_production_status`
returns `readyToActivate: true`. The fixed unit then locks deployment,
rechecks root-owned approvals, old symlink, backup integrity, staged Git
commit, clean checkout and artifact availability, runs Nginx preflight,
atomically switches the symlink, reloads PHP 8.4 FPM and verifies local
HTTPS /login plus the official CodeBridge icon. On a post-switch failure
it restores the old symlink and re-verifies rollback health. It never
runs unreviewed database migrations. A clean /login smoke is not a
replacement for **authenticated tenant**, enrollment, revocation and
customer UI acceptance.

## Release gate and limitations

- The operator-installed protected unit and target release are _not_
  currently deployed by this PR; do not claim remote command access is
  operational until the supervisor socket and real authenticated MCP
  tool catalog have been verified.
- If approval, backup, target path, service, live current symlink or
  health is absent, activation intentionally fails closed.
- Target service `kmj-main-platform-production-release.service` is fixed
  by the code. Deployment cannot be forced to an arbitrary SHA/branch.
- The product dashboard is not considered live until the production
  customer route, actual image/manifest assets, device controls and
  rollback are verified against the exact newly deployed SHA.
- One-time operator bootstrap is unavoidable while the existing agent's
  privileged supervisor is unavailable. Do not use Desktop Commander
  as an unauthorized workaround.
