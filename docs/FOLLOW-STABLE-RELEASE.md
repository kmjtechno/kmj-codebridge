# Agents follow the signed stable release

The signed updater installs a new runtime under `/opt/kmj-codebridge-stable`
and moves `current`. It restarts its own units, but the dev and CloudOS agents
run from `current` too and kept old code until restarted (seen 2026-11-23:
dev agent on 8c48ec92 while the release was a0d226ed).

`follow_stable_release.py` (root, systemd timer, every 5 min) restarts only
`kmj-codebridge-dev.service` and `kmj-codebridge-kmj-cloudos.service`, and only
when: the unit's WorkingDirectory is exactly the stable symlink, the target is a
real release dir, the target is older than 120 s, the agent has no child
process (no running job), and its process runs an older release. After restart
it verifies the new process runs the target; otherwise it exits 2 and prints
`RESTART_NOT_VERIFIED_REVIEW`.

It never touches the signed updater, gateway cutover, Main Platform, keys,
configs or the symlink. A permanently busy agent is deferred, not forced.

Install (owner root, one time): `python3 -I scripts/production/owner_install_follow_stable_release.py`
(dry run) then `--apply`. Not proven until installed and one real release is observed.
