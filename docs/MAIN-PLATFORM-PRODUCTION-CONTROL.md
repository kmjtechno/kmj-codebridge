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

## Initial host bootstrap — one-time operator step

Only after reviewing this source on an authorized KMJ-elite console, as root,
run the checked-in installer (do not run a network-fetched `curl | bash`
one-liner):

```bash
cd /path/to/verified/kmj-codebridge-checkout
sudo bash scripts/production/install-main-platform-control.sh
```

It only installs the **fixed inactive** unit and fixed root-owned script;
it cannot deploy by itself and does not create fake approvals or backups.
It may enable an existing CodeBridge supervisor socket but does not alter
stored enrollment/token files, OAuth settings or the development checkout.

The CodeBridge agent must separately have the documented
`supervisorSocket=/run/kmj-codebridge/supervisor.sock` configured in its
protected enrollment. If missing, repair it with the existing guarded agent
installer/rebind flow, never by pasting a token into chat.

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

- The operator-installed protected unit and target release are *not*
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
