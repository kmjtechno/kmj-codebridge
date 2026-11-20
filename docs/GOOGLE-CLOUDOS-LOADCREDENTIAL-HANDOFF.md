# Google CloudOS restricted Supervisor: unit-scoped credentials (source-only)

Related incident: #1115. **This change is not an installer, release, or authorization to retry the old bootstrap.**

## Verified defect

The legacy Supervisor unit has `User=root` but an empty `CapabilityBoundingSet=`; it cannot read the info-owned private `/home/info/.config/kmj-codebridge/agent.json` at mode 0600. The first successful socket activation was rolled back after the privileged RPC probes. No credentials or host services should be modified as part of this source change.

## Narrow proposed contract

- Only profile `KMJ_CODEBRIDGE_SUPERVISOR_PROFILE=cloudos` reads its agent JSON from the fixed unit-scoped `/run/credentials/kmj-codebridge-supervisor.service/agent.json` file. The original private config stays owned by `info:info`, mode 0600, unchanged and read by the normal agent.
- A separately reviewed, exact SHA-pinned **new** Google operator installer must include this systemd unit directive under `[Service]`:

```ini
LoadCredential=agent.json:/home/info/.config/kmj-codebridge/agent.json
```

- PID 1 makes the restricted copy for the service process, permitting an empty capability bounding set without broadening the home config permissions or adding `CAP_DAC_OVERRIDE` / `CAP_DAC_READ_SEARCH`. Do **not** use `SetCredential=` with secret bytes, `Environment=` to convey credentials, symlinks to the original file, ACL expansion, or an open socket to disclose contents.
- Keep the config path fixed in source. Missing credential, bad JSON, incorrect schema, or unexpected service identity must fail closed with categorical errors. No home-path fallback and no caller-provided config file.
- `project_status` uses the same credential; project-root traversal permissions remain a **separate gate** and are not silently bypassed by this patch.
- Existing unit `ProtectHome=tmpfs`, read-only project binds, sandbox profile, root-managed source, socket identity and immutable old stage must be independently attested before any installer upgrade.

## Acceptance before any runtime mutation

1. Source CI, Linux/Windows regression tests, security review, and protected merge on the exact head SHA.
2. A new source-pinned installer with independent verification of existing preserved `fa9340b9...` stage, proof that required Node24/lockfile artifacts are available, and **no implicit deletion**.
3. Independent staging proof of PID1 `LoadCredential` delivery and `config_validate`/ `project_status` failure classifications; prove wrong/missing credential denial and no read of the original file by the sandboxed root process.
4. Explicit owner-approved operator window, rollback recovery and verified new live RPC statuses. Existing Google VPS agent, API, worker and tenant data must survive. No paid VM operations.

**Do not rerun** `bootstrap-google-cloudos-supervisor.sh` with the historical SHA pin; it lacks the credential directive and still fails the verified access constraint. This PR intentionally does not edit that old installer or claim a new signed deployment.
