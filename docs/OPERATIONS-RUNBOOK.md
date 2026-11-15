# Operations runbook: data, backup/restore, uninstall and support

Scope: the Linux agent installed by `scripts/install-vps.sh`. Paths below are the
installer defaults and can be overridden by the `CODEBRIDGE_*_DIR` variables.
Nothing here is a claim about a live deployment; verify on your own device.

## 1. What data stays on the device

| Path                                            | Contents                                                                                                      | Sensitivity                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `/etc/kmj-codebridge/agent.json`                | device identity, grants, command profiles, device credential reference                                        | secret: never share or paste |
| `/var/lib/kmj-codebridge/audit/<project>.jsonl` | hash-chained record of tool attempts/results and licence state changes (codes only, no tool input, no tokens) | private                      |
| `/var/lib/kmj-codebridge/jobs/`                 | job journal and incremental logs                                                                              | may contain project output   |
| `/var/lib/kmj-codebridge/license-state.json`    | licence sequence and clock high-water marks                                                                   | integrity-critical           |
| `/opt/kmj-codebridge-agent`                     | installed code (replaceable)                                                                                  | public code                  |

The agent sends no project source to KMJ TECHNO by itself; tool results go only to the
MCP client the owner connected. Paid inference is never started by the agent.

## 2. Backup

Back up configuration and state, not the installed code.

1. Stop writers: `sudo systemctl stop kmj-codebridge-agent.service`.
2. Archive: `sudo tar --numeric-owner -czf codebridge-backup.tgz /etc/kmj-codebridge /var/lib/kmj-codebridge`.
3. Record the archive hash: `sha256sum codebridge-backup.tgz`; keep it separate from the archive.
4. Encrypt before leaving the host (for example with `age`); the archive contains the device credential reference.
5. Start again: `sudo systemctl start kmj-codebridge-agent.service`.

## 3. Restore

1. Verify the archive hash first. Restore only an archive you made.
2. Re-run the installer (it keeps a rollback copy), stop the agent, then extract over `/etc/kmj-codebridge` and `/var/lib/kmj-codebridge` preserving owners and modes (`0700` directories, `0600` files).
3. Start the agent and confirm it connects. A restored `license-state.json` older than the current licence is safe: the agent rejects a replayed lower sequence and a clock that moved backwards.
4. Audit ledger: a restored ledger must verify as an unbroken hash chain; a broken chain is reported as `AUDIT_LEDGER_INVALID`, never silently repaired.

## 4. Uninstall

`scripts/uninstall-vps.sh` is a **dry-run by default**.

```
sudo scripts/uninstall-vps.sh                 # shows the plan, changes nothing
sudo scripts/uninstall-vps.sh --apply         # stops/disables units, removes code; keeps config and state
sudo scripts/uninstall-vps.sh --apply --purge-data   # also deletes config and state (irreversible; back up first)
```

It only touches the installer's own directories and unit files, refuses unsafe paths
(`/`, `/etc`, `/usr`, relative paths, `..`, symlinks) and never touches other services.

## 5. Licence outage behaviour

- Signed mode: expired lease inside the grace window (at most 48 hours) keeps working; after it, calls fail closed with `LICENSE_EXPIRED`.
- Signed `REVOKED` fails closed with `LICENSE_REVOKED`.
- Optional `license.fallbackToFree: true` degrades an expired or revoked lease to Free (one project, one concurrent job) instead of locking out. Bad signatures, wrong binding, replay and clock rollback always fail closed.
- Customer data is never deleted by a licence state change. Each state change is written to the audit ledger.

## 6. Support checklist

Before opening an issue (see `SUPPORT.md`), collect, redacted: agent/runtime version, OS, `journalctl -u kmj-codebridge-agent.service -n 200`, the error code, and the audit tail. Never include `agent.json`, tokens, keys or personal data. Suspected vulnerabilities go to the private path in `SECURITY.md`, not a public issue.

## 7. Hosted gateway: release and incident checks

Written from the 13 to 15 November 2026 incidents on the hosted gateway host. Each
entry gives the symptom, what it was, and the check that tells it apart. Commands that
change the host are owner-run as root; nothing here is a reason to skip a dry run.

### Public MCP returns 502/503 but the gateway unit is active

Seen after a host reboot: the reverse proxy was not enabled at boot, so nothing
listened on 443 while the loopback gateway answered normally.

- Check: `systemctl is-active nginx`, `systemctl is-enabled nginx`, and a listener on
  port 443.
- Fix: start the proxy after its config test passes, and enable it at boot.

### Gateway unit is in `auto-restart` and the journal says `Startup failed`

From the release after sequence 25 the line carries a code, for example
`Startup failed [CONFIG_MODE_NOT_PRIVATE]`. Older runtimes print no code.

- `CONFIG_MODE_NOT_PRIVATE`: the config file has group or other permission bits. On
  14 November 2026 the file had been changed to `root:<service group> 0640` while the
  gateway kept running; the next restart could not start on either the new or the
  previous runtime, so the automatic rollback failed too.
- `CONFIG_JSON_INVALID`, `CONFIG_SCHEMA_INVALID`: the config content.
- `EADDRINUSE`: another process holds the port.
- Check first: `stat -c '%U:%G %a' <config>` and the unit's `User=`.
- After repeated failures systemd may refuse a manual start until
  `systemctl reset-failed <unit>`.

### Changing who owns the gateway config

The Supervisor's fixed trust rule wants a root-owned file; a gateway before the
release containing #929 refuses anything but owner-only permissions. Do not change
ownership or mode of the live config until **both** the running runtime and the
runtime a rollback would return to accept the new layout. Until then
`supervisor_config_validate` reporting `CONFIG_TRUST_INVALID` for a service-owned
`0600` file is expected and is not a fault to repair. Any future change needs a
preflight that proves the gateway can start with the proposed owner and mode, not only
that a validator accepts it.

### Signed updater trigger stops with `SIGNED_JOURNAL_CURSOR_UNAVAILABLE`

The 20261103 trigger needed a prior journal entry for the updater unit in the current
boot; after a reboot there is none. Use `owner-trigger-signed-update-20261114.sh`,
which prints `CODEBRIDGE_SIGNED_JOURNAL=NO_PRIOR_ENTRY_THIS_BOOT` and verifies the
unit's whole current-boot journal instead. The trigger stops before starting anything
when it blocks.

### Gateway cutover result codes

- `SIGNEDnn_CURRENT_POINTER_MISMATCH`: the updater has not installed the release yet.
  Nothing was changed.
- `GATEWAY_CONFIG_NOT_STARTABLE_MODE_OR_OWNER`: the config would not let the gateway
  start. Nothing was changed.
- `GATEWAY_RESTART_NOT_ACTIVE` followed by `GATEWAY_ROLLBACK=FAILED_OWNER_REVIEW_REQUIRED`:
  the gateway is down. Save the unit journal, move the newest drop-in out of the
  drop-in directory if it is still there, `daemon-reload`, `reset-failed`, start the
  unit, then find the startup code. The lock file under `/run/lock` is left in place on
  purpose; remove it only after the cause is understood.

### A client is signed in but every write tool returns `ACCESS_DENIED`

`account_diagnostics` shows `access.grantedScopes` and, per missing permission, either
`OAUTH_SCOPE_NOT_GRANTED` (this sign-in did not receive the scope) or
`ACCOUNT_PERMISSION_NOT_GRANTED` (the account lacks it). For a client that never steps
up, see `oauth.signInScopes` in [OAUTH.md](OAUTH.md).

### Agents keep reconnecting

`account_diagnostics` reports `recentSessionCount` and `sessionChurn` per agent, and
`connection_overview` adds `sessionChurn: "flapping"`. A healthy agent opens one
gateway session per gateway or agent start. Before sequence 25 every idle agent opened
a new session about every 30 seconds because the gateway held an empty poll longer
than the agent's request timeout.

### Release signing on the key host stops at the first step

`git switch` refuses to overwrite an untracked file when `main` tracks a file at the
same path. Build output such as `__pycache__` must never be committed; the repository
ignores it since #922.

## Owner scripts after the signed27 cutover

All three are root-only on KMJ-elite, pinned by SHA-256 before running, and print
fixed tokens only. A merge does not run them.

| Script (`scripts/production/`)                        | Changes                                                                                                                                                                                                                                                                             | Default                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `owner_check_signed27_rollback_readiness_20261115.py` | Nothing. Checks that a gateway rollback to signed25 would start: override bytes, release tree, config owner/mode, and the signed25 schema against the live config.                                                                                                                  | read-only, no arguments                                                            |
| `owner_switch_supervisor_signed27_20261115.py`        | One later Supervisor `ExecStart` drop-in; no restart. Needed because the gateway cutover and the updater do not move the Supervisor unit.                                                                                                                                           | dry-run; `--apply`, `--rollback`                                                   |
| `owner_enable_gateway_signin_scopes_all_20261115.py`  | One key, `oauth.signInScopes: "all"`, in the gateway config, then one gateway restart; restores the previous bytes if the expected sign-in challenge does not appear. See [OAUTH.md](OAUTH.md).                                                                                     | dry-run; `--apply --confirm-no-active-jobs`, `--rollback --confirm-no-active-jobs` |
| `owner_activate_signed28_gateway_20261115.py`         | One later gateway drop-in (signed28); one gateway restart; rolls back to the signed27 override on any failed check. Done on 2026-11-15.                                                                                                                                             | dry-run; `--apply --confirm-no-active-jobs`                                        |
| `owner_config_root_group_20261115.py`                 | Gateway config directory and file to `root:kmjcode` 0750/0640 so `supervisor_config_validate` stops reporting `CONFIG_TRUST_INVALID`. No restart. Proves the shape with a dummy file first; restores the original owner on failure. **Not applied; needs the owner's separate go.** | dry-run; `--apply`, `--rollback` with `--confirm-root-group-config-owner-go`       |

Run the readiness check before and after the sign-in scopes change. After that change a
client that was read-only has to sign in again in the browser to be offered the wider
consent; the gateway restart drops agent connections for a few seconds.
