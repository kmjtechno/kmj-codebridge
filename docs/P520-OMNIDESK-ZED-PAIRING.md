# P520 / Zed → KMJ OmniDesk project pairing

**Status:** Source workflow only until this branch merges, the trusted local CodeBridge runtime is safely updated, and a real owner-browser enrollment finishes. **No claim of successful pairing from CI alone.**

## Why OAuth is green but file access is denied

Zed's `CodeBridge` green indicator and `Log Out` mean the MCP client has authenticated, not that the device/project agent is enrolled. `device1` may be a dormant, never-seen identity: do not assume it is the physical P520.

Call `list_devices` without a placeholder and then `connection_overview({expectedProject:"kmj-omnidesk"})`. `ACCOUNT_PROJECT_GRANT_MISSING` means the authenticated owner does not yet have a real project grant.

## Owner's exact machine and project

- Approved intended Windows host: `DESKTOP-5FVJMET` (Home Office P520; verify this on the actual PC)
- Local project root: `E:\KMJ\KMJ OmniDesk`
- Expected Git remote: `https://github.com/kmjtechno/kmj-omnidesk[.git]` or exact SSH equivalent
- **Exact CodeBridge project ID:** `kmj-omnidesk`
- Zed remote MCP: `CodeBridge` → `https://kmjtechno.com/mcp`

The universal connector used to derive a project ID only from the physical folder name. The approved path includes a space, so the old release rejects it. This fix validates the explicitly selected Git root and maps an unsupported folder display name to a strict canonical GitHub repository slug. It keeps the existing behavior for valid folder names. The same resolution is used for existing-enrollment discovery and first pairing.

## One owner action after the updated trusted CodeBridge checkout passes exact-head Windows checks

From the **clean, owner-reviewed CodeBridge checkout on that P520**, double-click `scripts/windows/CONNECT-P520-OMNIDESK.cmd` as the normal Windows user. This wrapper selects the fixed local OmniDesk folder; it does **not** execute code from a remote download, alter PowerShell policy, widen an existing project, copy credentials or authorize the device automatically.

The underlying universal launcher verifies CodeBridge Git origin, clean source, tracked launcher, Node 24+, local Git root and existing private enrollments. A new unpaired project requests a separate verifier-bound browser approval at the official KMJ domain; inspect that the device name and **`kmj-omnidesk`** project match before approving. A failed readiness/approval check must stop without overwriting another project's private agent configuration.

If `https://kmjtechno.com/api/codebridge/v1/device-enrollments/readiness` is unavailable, the production Main Platform pairing contract must be repaired/guardedly deployed first. Do not downgrade the client, bypass protected release gates, paste tokens or manufacture a pairing record.

## Acceptance, in order

1. Zed OAuth / CodeBridge server active.
2. On the **actual owner P520**, clean trusted runtime and exact project root verified; no P720 use.
3. Real owner browser approval and one scoped private OmniDesk agent config created.
4. An authenticated project-specific gateway heartbeat is observed.
5. `connection_overview({expectedProject:"kmj-omnidesk"})` returns `READY` with the actual enrolled P520 OmniDesk device ID.
6. `inspect_project`, read-only `README.md` / `ROADMAP.yaml`, exact-head Git, tests and quality gate results independently checked.

The Main Platform **Assign project** form only stores a `pending_local_setup` request. It does **not** itself provide local filesystem grants or prove an online CodeBridge agent. Do not represent that request as READY.

**Release boundaries:** Preserve other registered CodeBridge agents and credentials, keep P720 offline, zero additional paid spend, no unattended owner approval, no unlocked root/shell, no Git reset/clean, and no OmniDesk commercial release without M4/M5/M9/M11–M14 real evidence.
