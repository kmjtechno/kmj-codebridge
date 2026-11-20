# Elite dev agent: bounded 24x7 loops

`scripts/production/owner_enable_dev_autopilot.py` (root, dry-run by default)
turns on three existing, opt-in features for the **dev** agent
(`kmj-codebridge-dev.service`, project `kmj-codebridge`) only:

| Loop                        | What it does                                                                                                                                                                    | What it never does                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI watch (every 15 min)     | Reads GitHub Actions for the checkout's exact HEAD (public, read-only). A failed `verify (ubuntu-24.04)` on `main` queues one repair task.                                      | No tokens, no logs, no polling on every heartbeat.                                                                                                                            |
| Isolated repair `format`    | In a detached worktree runs `prettier --write` on `src/ scripts/ tests/ plugin/ docs/ README.md`, then `prettier --check`. The patch stops at `VERIFIED_PATCH_AWAITING_REVIEW`. | No push, PR, merge or deploy. Workflows, `package*.json`, `SECURITY.md`, `CLAUDE.md`, releases and `config/` are outside the allowlist, so a patch touching them is rejected. |
| Checkout sync (every 5 min) | `fetch` + `merge --ff-only origin/main` as the unprivileged `kmjdev`, only when the checkout is on `main` and completely clean.                                                 | No reset, no force, no checkout of other refs, never touches a dirty tree.                                                                                                    |

Not enabled, on purpose: the local/cloud coding worker (needs a model and
explicit source-transfer consent), the gate worker, and any config for other
agents. No new permission, token or model is added; the script refuses to run if
a coding or local worker is already enabled in this project.

## Run (owner, on KMJ-elite)

```bash
python3 -I owner_enable_dev_autopilot.py                                  # dry run
python3 -I owner_enable_dev_autopilot.py --apply --confirm-restart-dev-agent
```

Apply backs up `agent.json` to `/root/dev-autopilot-backup/`, validates the new
config with the **live runtime's** schema, restarts only the dev unit and rolls
everything back if it does not come up. Re-running is idempotent.

## Honest limits

- This repairs CI **formatting** failures as reviewed candidates. It is not
  autonomous feature coding, and "loop started" is not proof of a repair.
- Review slots are limited (four lanes); unreviewed candidates occupy them.
- Live behaviour is unproven until the owner runs the script and a real CI
  failure is observed.
