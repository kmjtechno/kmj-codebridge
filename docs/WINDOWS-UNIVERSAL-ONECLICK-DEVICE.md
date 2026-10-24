# KMJ CodeBridge — one-click connection on any Windows PC

The generic Windows launcher is no longer tied to a particular customer, computer name, product repository or Lenovo P720. The fixed-specific Home Office/P720 launchers remain available as separate reviewed paths.

## On the Windows PC

Get a **trusted, tracked-clean** local CodeBridge checkout with Node.js 24+, Git and its existing npm dependencies; then double-click:

`scripts/windows/CONNECT-ANY-DEVICE.cmd`

Choose **YES** for a previously enrolled CodeBridge device and pick its existing private `agent.json` file on that same computer. No token is copied, reset, displayed, or reissued. Only a private config whose device ID ends in this computer's normalized Windows name, matches the trusted `https://kmjtechno.com` gateway, and has valid project/state scopes can be used.

Choose **NO** to pair a new Git project: select its _existing local Git repository root_, then approve the new device/project in your owner's official browser. The CodeBridge enrollment helper displays the short-lived approval link and code locally, not the permanent bearer token. The new config is created only inside the current user's `%LOCALAPPDATA%\KMJ-CodeBridge\private\devices\...` folder with restricted ACLs. Existing config files are never overwritten.

After a verified local reconnect, the launcher creates a **current-user Windows Startup shortcut** for that exact private `agent.json`. The next time the same owner signs into Windows, it attempts to start that existing approved agent automatically without user interaction or re-pairing. More than one separately approved project/device can be managed with separate private-config shortcuts, while a duplicate for the **same** config is reused.

To disable automatic startup for one enrollment, double-click `scripts/windows/DISABLE-ANY-DEVICE-AUTOSTART.cmd` and choose the original private `agent.json`. Only the exact matching shortcut is removed; a live agent remains running. A changed or unsafe existing shortcut blocks replacement and deletion.

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
