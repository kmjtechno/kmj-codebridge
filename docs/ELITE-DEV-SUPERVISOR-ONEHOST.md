# Elite CodeBridge Dev Supervisor — guarded one-host handoff

**Scope:** `kmj-codebridge-elite` / `kmj-codebridge` only. All execution
and signing stays on **KMJ-elite**. Google VPS remains CloudOS-only. This
documentation and the offline renderer perform **no host mutation**.

## Boundary

The development device is already enrolled under
`kmj-codebridge-dev.service`, as the dedicated non-root account `kmjdev`.
It must never share or chmod/chgrp the Main Platform socket
`/run/kmj-codebridge/supervisor.sock`, or the CloudOS socket
`/run/kmj-codebridge-cloudos/supervisor.sock`.

The reviewed source implements profile `codebridge-dev-elite`: one fixed
`kmj-codebridge-dev.service`, one fixed socket
`/run/kmj-codebridge-dev/supervisor.sock`, and read-only `status`,
`device_status`, `disk_space` only. Restart, release, project, configuration,
logs and privileged production actions are rejected. It does not turn the
Supervisor into a general root shell.

## Step 1 — deterministic offline render, not an installation

From a clean, reviewed source checkout:

```bash
python3 -I -B scripts/production/render-elite-dev-supervisor-units.py \
  --source-sha <independently-reviewed-exact-40-hex-source-sha> \
  --version <signed-manifest-version>
```

The output is JSON with the proposed service/socket text, plus explicit
`installed=false`, `operator_approved=false`,
`source_signed_and_verified=false`, and `socket_acl_verified=false`.
The renderer has **no `--apply` option**. Never pipe its JSON into shell,
`systemctl` or `sudo`. Output is a candidate for independent root review.

## Step 2 — signed installer source (owner activation not performed)

The separate `scripts/production/owner_install_elite_dev_supervisor.py` is
dry-run by default, requires the **original Ed25519-signed stable manifest**
and archived source to match a root-owned installed runtime at
`/opt/kmj-codebridge-stable/releases/<version>-<sha12>`. It verifies source
bytes including its own installer before importing any renderer. The exact
signed manifest version and SHA select the fixed unit runtime directory.

From the signed release directory **only**, the Elite owner first runs the
read-only root preflight:

```bash
sudo /usr/bin/python3 -I -B /opt/kmj-codebridge-stable/releases/<version>-<sha12>/scripts/production/owner_install_elite_dev_supervisor.py --revision <signed-40-hex-sha>
```

Only after verified preflight and independently approved signing and host
change, the exact fixed apply grammar is
`--revision <sha> --apply --confirm-elite-dev-signed-supervisor-owner-go`.
Do not invoke this script from a writable checkout or bypass the signature
check. This installer creates **only** the private read-only socket/service,
probes read-only and denied RPCs, then reports
`PASS_AGENT_BINDING_NOT_ATTEMPTED`. It never restarts or re-enrolls the dev
agent, never edits the private agent config, and does not deploy the public
website. Agent binding remains a separate signed/job-drained handoff.

## Step 3 — future agent binding (source only, not activated)

The enrolled development agent now supports an opt-in **operator unit flag**
`KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND=1`. It selects exactly the
dedicated read-only `/run/kmj-codebridge-dev/supervisor.sock` without
editing or copying the private enrollment file or its token. Missing flag
preserves the existing behavior and does not silently connect.

Before accepting the flag at agent startup, the signed runtime checks Linux,
the exact device ID `kmj-codebridge-elite`, the single enrolled
`kmj-codebridge` project, the absence of any other socket or Windows pipe,
and a currently installed Unix socket owned by the non-root agent UID/GID,
mode `0600`, under a root-owned, non-group-writable directory. Every mismatch
fails closed before agent credential resolution or acquiring its state lock.
The flag is _not_ a host installer, a signature, a permission grant or a
service restart. No GitHub file or chat message may set it on behalf of
the operator.

An independently reviewed, owner-signed **root-managed systemd drop-in**
and job-drained activation are still required to make the flag effective
on the actual Elite agent. No running agent may be restarted just to
enable this code, and the signed host installer remains separate from
agent binding. After such activation, recheck real authenticated Supervisor
RPCs (including denied restart/gateway requests) and the one-click dashboard;
otherwise `SUPERVISOR_NOT_CONFIGURED` remains correct.

## Step 4 — additional guardrails and live proof requirements

A separate operator-controlled, signed and pinned Elite-only installer must:

1. Verify host identity and root privilege without trusting caller-controlled
   PATH, source URL, branch, unit name, service user or socket path.
2. Independently authenticate the owner-signed immutable release manifest and
   source SHA using the original pinned release public key. Validate the
   **entire** staged runtime tree is root-owned, non-writable by unprivileged
   users and free of symlink escape; execute Node only from a verified
   root-managed path. Neither checkout HEAD nor this renderer's SHA input
   counts as a cryptographic signature.
3. Verify `kmj-codebridge-dev.service` is the sole intended agent and runs
   under `kmjdev`; preserve its private enrollment, state and existing
   project checkout. Verify effective systemd config before and after.
4. Prove the dedicated socket and systemd unit names are absent or an exact,
   byte-identical previously installed instance; **never overwrite** another
   service or socket. Service runs as **kmjdev**, not root.
5. Create in the root-controlled systemd directory using a private
   temporary inode, fsync its complete bytes, and atomically hard-link
   create-only into the **absent** final unit name. Never rename-overwrite an
   existing unit or expose a partially written file. Fail closed on any
   collision; do not restart the enrolled agent. Roll back only files owned
   by this invocation, and preserve unrelated pre-existing units.
6. Validate with systemd and a real authenticated/authorized read-only RPC
   probe. The socket must be `0600`, owned by `kmjdev`, with correct
   directory traversal permissions, and must not grant Main Platform or
   CloudOS access.
7. On any install or health fault, roll back only its own files/socket and
   verify the original units, agent and gateway remain intact. Failed
   rollback is a **manual recovery blocker**, not a PASS.

The signing and published feed are not inferred from GitHub merge alone.
Until a guarded host activation and direct live readback succeed,
`SUPERVISOR_UNAVAILABLE` remains correct. The source PR does not start,
stop, restart, or re-enroll any service. `/codebridge-connect.html` and
Mission Control UI need their own signed website release and HTTPS readback.

## Verification labels

- `SOURCE_QA_PASS`: renderer and negative tests passed for a specific SHA.
- `HOST_INSTALL_PASS`: root-owned signed installer and atomic rollback
  passed, with exact host/unit/socket observations.
- `LIVE_AGENT_RPC_PASS`: authenticated agent sees the dedicated live
  Supervisor and read-only operations work; prohibited RPCs remain refused.
- `DASHBOARD_LIVE_PASS`: public customer-domain Mission Control release SHA
  and actual one-click device controls are verified.

These are independent gates. Do not collapse them into a single `READY` label.
