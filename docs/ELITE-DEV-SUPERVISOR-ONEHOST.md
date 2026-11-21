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
  --source-sha <independently-reviewed-exact-40-hex-source-sha>
```

The output is JSON with the proposed service/socket text, plus explicit
`installed=false`, `operator_approved=false`,
`source_signed_and_verified=false`, and `socket_acl_verified=false`.
The renderer has **no `--apply` option**. Never pipe its JSON into shell,
`systemctl` or `sudo`. Output is a candidate for independent root review.

## Step 2 — installer requirements (not implemented or authorized here)

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
5. Create with private temporary files and atomic create-only operations;
   retain full byte-identical backups and fail closed on every mismatch.
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
