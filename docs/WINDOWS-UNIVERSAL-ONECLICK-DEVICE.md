# KMJ CodeBridge — one-click connection on any Windows PC

The generic Windows launcher is no longer tied to a particular customer, computer name, product repository or Lenovo P720. The fixed-specific Home Office/P720 launchers remain available as separate reviewed paths.

## On the Windows PC

Get a **trusted, tracked-clean** local CodeBridge checkout with Node.js 24+, Git and its existing npm dependencies; then double-click:

`scripts/windows/CONNECT-ANY-DEVICE.cmd`

**Fastest path (true one click):** drag your project folder onto `CONNECT-ANY-DEVICE.cmd` (or run `CONNECT-ANY-DEVICE.cmd "C:\path\to\project"`). No dialog and no folder picker appear. If that folder is already paired on this PC, the existing agent reconnects. Otherwise the owner browser approval opens directly.

On a PC with **nothing paired yet**, double-click goes straight to the folder picker and browser approval. On a PC with existing enrollments, a single project/device selector offers the existing projects and **Connect a new project**. Customers do not select private JSON files. Existing project connection does not request another browser approval. Duplicate device identities fail closed; the launcher does not guess which credential is correct.

To add a new project, select its existing local Git repository root and approve the exact grant in the official owner browser. The short-lived approval link/code stays local, and permanent credentials stay private. New configs are created under the current user's protected local device store. Existing configs, project files and private-store ACLs are preserved. Retry of an empty cancelled reservation is allowed; nonempty partial enrollment requires safe recovery rather than deleting files.

After a verified local reconnect, the launcher creates a **current-user Windows Startup shortcut** for that exact private `agent.json`. The next time the same owner signs into Windows, it attempts to start that existing approved agent automatically without user interaction or re-pairing. More than one separately approved project/device can be managed with separate private-config shortcuts, while a duplicate for the **same** config is reused.

To disable automatic startup for one enrollment, double-click `scripts/windows/DISABLE-ANY-DEVICE-AUTOSTART.cmd` and choose the project by name. Only the exact matching shortcut is removed; a live agent remains running. A changed or unsafe existing shortcut blocks replacement and deletion.

## Security/operation boundaries

- The launcher is for **Windows desktops/workstations**. Do not claim this package installs automatic startup on Linux, macOS, iOS, Android or an unreachable machine. Non-Windows agent enrollment requires the platform's own installer and supervisor.
- A **first local action** on each new computer and owner browser approval for new device grants are necessary; a GitHub PR merge never remotely installs the agent.
- No unrestricted shell, elevation/admin service, Windows task creation, new paid infrastructure, credential export, remote command execution or change to owner project source.
- Git identity and tracked-clean source checks apply to CodeBridge itself, **not** a forced reset of the owner's project. For a new project, its existing Git root and nonempty remote are checked, but owner browser approval is still essential.
- Fail closed for multiple agent processes, a live mismatching lock holder, untrusted config or script paths, foreign-machine credentials, missing runtime/dependencies, altered Startup shortcut, or a preexisting active P720 boot task.
- A local agent process and fresh local heartbeat are **not** account-level device availability. Check the authenticated CodeBridge client `connection_overview` for `READY`. The current Home Office gateway registration is not verified READY as of the last account-side read.
- The logon shortcut carries the private **path** only (not the token), and is stored in the signed-in user's Windows Startup folder. The actual token remains in its existing ACL-protected private file.
- Test harness on GitHub-hosted Windows creates **only a disposable shortcut**, validates host restrictions, and refuses unattended pairing. It does not enroll or activate a real workstation.

For existing Home Office and P720 devices, the previously tested specialized one-click launchers still provide safer device-specific recovery paths. This generic wizard is intended for new Windows devices and future customer workstations.

## Customer setup acceptance contract (release gate)

**Product requirement:** one customer-facing Install / Connect / Repair / Update action per operation, with a single explicit approval only when a new device or expanded capability requires it. Do not make customers run terminal commands, find credentials, manually restart agents or repeat pairing. No PC reboot as a routine setup step.

The signed installer should discover platform/toolchain and enrolled devices, select only compatible reviewed capability profiles, stage changes with protected backups, drain active work, verify the exact configuration and signed runtime, reload only the affected agent, prove fresh authenticated gateway readiness and actual capability execution, and automatically roll back a failed change. If prerequisites or authorization are missing, present one specific action in the same UI; never hide failed gates behind a successful installer exit. Preserve dirty/untracked project files and existing grants. An existing already-running process is not a new heartbeat and must be verified in the dashboard.

This PR implements the connection selector, native ancestry fix, and existing-agent owner/lock check. It does not yet implement a generalized signed native setup/recovery orchestrator, automatic development profile enrollment, Windows update drain/rollback, packaging, entitlement upgrades or hardware activation. Each must pass real device acceptance before customer-ready release; P520-specific helper scripts are not a generic customer installer.
