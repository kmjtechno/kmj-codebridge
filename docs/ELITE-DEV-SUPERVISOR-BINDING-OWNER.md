# Elite dev Supervisor — owner-signed binding drop-in (source stage)

This is a guarded follow-on to the dedicated socket installer and the
`KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND=1` agent-side admission. Scope:
**KMJ-elite only**, enrolled device `kmj-codebridge-elite`, project
`kmj-codebridge`, service `kmj-codebridge-dev.service`, Unix socket
`/run/kmj-codebridge-dev/supervisor.sock` and service identity `kmjdev`.

## Preconditions and execution

The root-only script is
`scripts/production/owner_stage_elite_dev_supervisor_binding.py`.
It is not a general service controller or a substitute for an owner-signed
release. Only the original owner Ed25519-signed, currently installed immutable
source tree passes preflight. The original private signing key never enters
CodeBridge or this script.

A root operator must first ensure the independent dedicated Supervisor
socket installer has already passed an authenticated local status request,
denied restart and gateway requests, and verified a 0600 socket under kmjdev.
The enrolled agent must still be active as kmjdev.

From the exact **owner-signed immutable runtime**, the read-only preflight is:

```bash
sudo /usr/bin/python3 -I -B /opt/kmj-codebridge-stable/releases/<version>-<sha12>/scripts/production/owner_stage_elite_dev_supervisor_binding.py --revision <original-owner-signed-40-hex-source-sha>
```

Only after preflight and separate operator approval, the fixed create-only
drop-in staging invocation adds
`--apply --confirm-elite-dev-supervisor-root-binding-owner-go`.

The only new file is
`/etc/systemd/system/kmj-codebridge-dev.service.d/80-kmj-signed-dev-supervisor-binding.conf`.
Its fixed contents add a dependency on the existing private socket and the
single environment flag. The file is staged privately, fsynced and
create-only published atomically. Any colliding file, untrusted parent,
missing signature, wrong unit identity, open socket ACL, unexpected agent PID
or changed enrollment bytes blocks the apply. The installer keeps private
config bytes and credentials unchanged and never overwrites existing units.

The installer runs `systemctl daemon-reload` only after creating its exact
drop-in. **It never stops, starts, restarts or re-enrolls the agent.**
Consequently even a successful staging output must report
`DEV_AGENT_BINDING_LIVE_RPC=NOT_YET_VERIFIED`. Activation needs a separate
**job-drained**, approved agent start/restart and authenticated CodeBridge
Supervisor RPC readback. The dashboard also requires its own signed web
deployment and live customer-domain verification.

## Independent gates

- **SOURCE_QA_PASS:** reviewed branch, exact-head Ubuntu/Windows CI and
  negative tests pass
- **SIGNED_RELEASE_PASS:** original owner signature and immutable archive
  verified on KMJ-elite, monotonic release activation confirmed
- **DROPIN_STAGE_PASS:** trusted owner-root preflight and create-only stage
  succeed; no existing agent restart
- **LIVE_BINDING_PASS:** subsequently restarted job-drained enrolled agent
  reports the fixed socket, local read-only RPC succeeds, and forbidden RPC
  remains denied
- **DASHBOARD_LIVE_PASS:** one-click customer-domain controls verified

No gate can substitute for a later gate. A published source branch or staged
unit file does not mean the production Supervisor is working.
