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
