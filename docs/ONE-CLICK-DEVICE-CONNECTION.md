# One-click CodeBridge device connection — Windows P720 (existing enrollment)

Status: **first-party reconnect launcher implemented in source**. The launcher is not a headless Windows service, and source CI alone is not a physical P720 customer acceptance.

## One double-click, no Git checkout changes

For the **already paired** `kmj-p720-<computername>` device and `kmj-codebridge` project, use `scripts/windows/CONNECT-P720-CODEBRIDGE.cmd` from a trusted release of the CodeBridge repository. Normal user; **do not run as Administrator**. The launcher invokes `CONNECT-P720-CODEBRIDGE.ps1` beside it, with normal Windows RemoteSigned policy rather than Bypass.

The current supported installed runtime is an immutable detached Git release in `D:\KMJ-HyperSpeed\codebridge-releases\5334ebf83a4d2eac8135f6a4eb84a5f2d61f4674`. Both `node.exe` 24+ and Git are prerequisites. If the immutable runtime is absent, first use the independently reviewed, guarded native updater and full CI to stage it; the one-click launcher **will not fetch or install executable code**. Never copy credentials from another device.

On double-click it:

1. Reads the existing *private* P720 agent configuration without printing tokens and validates the exact canonical HTTPS gateway, device ID, single project, project root and state directory.
2. Requires non-reparse paths, a clean tracked **release** checkout, trusted Git origin, full pinned SHA and installed Node dependencies. It does **not** require the user's separate main development checkout to be clean.
3. Checks only the P720 config-scoped process. If one agent exists, reports `DEVICE_CONNECT=ALREADY_RUNNING` and does not start another; if multiple or a live conflicting lock exists, refuses to proceed. A stale lock is left for the agent's own proven-stale lock algorithm; never delete it manually.
4. Requires HTTPS `/agent/health` without a token to return **401**, then starts **one** user-session agent from the installed pinned runtime, with logs under the owner-private state directory.
5. Requires the new process to stay uniquely scoped and a **fresh** local gateway-authenticated `connection.json` record. A PID by itself or anonymous HTTP 401 is **not** success.
6. Reports only bounded marker codes. Verify actual account/device/project grant from an authenticated CodeBridge client using `connection_overview`.

**Read-only preview:** in a trusted PowerShell window run `powershell.exe -NoProfile -File scripts\windows\CONNECT-P720-CODEBRIDGE.ps1 -CheckOnly`. `-SelfTest` tests fixed scope validation without reading real enrollment or accessing the network.

## Pair a brand-new device

This launcher never fabricates enrollment or reuses another device's token. If `PAIRING_REQUIRED_USE_OWNER_APPROVED_PAIRING_LAUNCHER` appears, use the already implemented `RUN-P720-CODEBRIDGE-PAIR.cmd` in a **trusted clean** project checkout, then approve the short-lived KMJ Main Platform HTTPS browser pairing prompt. The enrolled device and project must pass the separate account-side grant check. A multi-OS new-customer single-click installer and signed always-on Windows service are separate release gates; **not included in this change**.

## Explicit limitations

- **Only existing approved P720 CodeBridge** for now; CineCore and Calibration have separate enrollments and are never touched. No general arbitrary device paths, local commands, remote shell or extra paid infrastructure.
- Runs under the current user session. **No boot/logoff persistence**; no enabled S4U task, LocalService credential sharing or Windows Supervisor takeover. Permanent 24/7 operation requires a reviewed dedicated service identity, fresh/rotated enrollment and a single-device lease.
- Does not stop existing jobs or replace a running agent. Changes to an installed runtime require the separate guarded agent updater with rollback.
- A successful local heartbeat is **not** a server-side authorization claim, full product release, signed stable update or proof of active autonomous coding. Check `connection_overview` and the service's independent deployment evidence.
- Never upload `private\`, enrollment/config files, command-line arguments or raw agent logs. Share only the marker lines beginning `DEVICE_CONNECT=`, `CONNECT_PREFLIGHT=`, `ACCOUNT_GRANT=`, `DIRTY_CHECKOUT=`.

## Acceptance

CI must validate Windows PowerShell parsing and the allowlisted project/gateway validator; Ubuntu/Windows check/test/client/distribution gates must pass at exact PR head. Then a separate owner double-click must show `ALREADY_RUNNING` or `LOCAL_AUTHENTICATED_HEARTBEAT` and an independently authenticated `connection_overview` must show `READY`. Do not claim a physical install from CI alone.
