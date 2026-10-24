# KMJ CodeBridge — one click connect and automatic sign-in reconnect (Windows)

This is **CodeBridge agent lifecycle only**. It does not develop or update Calibration Pro, launch camera hardware, change DNS, install a Windows service or use a paid runner.

## One-time setup, without pasting commands

Use an **updated trusted CodeBridge checkout with its dependencies already installed** on the Windows device:

| This Windows device           | Double-click                                       |
| ----------------------------- | -------------------------------------------------- |
| Home Office `DESKTOP-5FVJMET` | `scripts/windows/ONE-CLICK-HOMEOFFICE-CONNECT.cmd` |
| Lenovo P720 `DESKTOP-K3AHHEM` | `scripts/windows/ONE-CLICK-P720-CONNECT.cmd`       |

The two identities are deliberately separate. A launcher refuses the other machine. Each performs the existing scoped and guarded reconnect, then creates **one current-user Windows Startup shortcut**. That means the same approved agent is automatically launched **when the owner signs in to Windows again**. It does not start an agent before a Windows user logs in and does not guarantee recovery from unexpected crashes while the user is already signed in.

Home Office: The reconnect script searches its known private directories for an **existing** correctly-scoped enrollment. For safe unattended startup it uses `-AutoDiscover -NoPicker` and will never show a file dialog. Only during the _initial deliberate one-click setup_, when no matching enrollment is found in the known private locations, it may invoke the existing owner browser-approved pairing wizard. No silent new device is created. If a private enrollment exists elsewhere, use the legacy/manual approved reconnect rather than create a duplicate. The Home Office launcher never uses the P720 enrollment.

P720: Requires the existing approved P720 enrollment and pinned CodeBridge runtime and explicitly refuses a concurrently enabled legacy `KMJ-CodeBridge-P720-Agent` Scheduled Task. It does not change that task, stop a supervisor, change a Windows service, or invent missing pairing credentials. Existing enrolled P720 projects other than CodeBridge are outside this shortcut's scope.

## Safe lifecycle behavior

- Current-user Startup folder only; **no admin privilege**, new Windows service, global Run key, boot-level Scheduled Task, or machine-wide modification.
- The startup shortcut calls the audited `ONE-CLICK-AGENT-AUTOCONNECT.ps1 -Device <scope> -AtLogon` **noninteractively**. It only reconnects previously enrolled agents; never opens pairing, asks for approval or file picker at sign-in.
- Existing agent-process/lock and local heartbeat checks remain in the underlying scoped reconnect scripts. No second process is started when an agent is already running. Only the authenticated CodeBridge client/server can confirm an account-side READY state; a live Windows PID or local heartbeat alone is not a remote grant.
- The CodeBridge checkout must be Git-origin trusted and tracked-clean. Owner changes are preserved (never `reset`, `clean`, `stash`, `pull`, or force replacement).
- Any different pre-existing shortcut of the same scoped name blocks registration. A matching one is reused idempotently. The existing startup configuration of any other app/agent is untouched.
- No bearer token, enrollment file, process command line, secret, or private folder is copied into the shortcut or printed to ChatGPT. Runtime scripts use their existing private config under the same Windows user.
- If a device is offline or a precondition fails, the launcher prints a fixed `KMJ_AUTOCONNECT=BLOCKED:...` marker. It cannot fix an unplugged PC or bypass owner/browser approval.

## One-click opt out

From the same trusted CodeBridge checkout double-click:

- `scripts/windows/DISABLE-HOMEOFFICE-AUTOCONNECT.cmd` on Home Office, or
- `scripts/windows/DISABLE-P720-AUTOCONNECT.cmd` on P720.

Only an **exactly matching** CodeBridge shortcut is removed. The currently running agent, all enrollment secrets, original project checkout, and other startup entries are preserved.

## Evidence and verification

Native Windows tests exercise the real Windows shortcut API in a disposable temporary directory and reject a wrong-host invocation, without registering any CI agent at sign-in. The standard CodeBridge Windows + Ubuntu matrix still enforces the production npm security audit and all regression tests. This does **not** prove successful operation of the owner's Home Office/P720 machines. After the owner runs the one-click launcher **locally**, check `connection_overview` from an authenticated CodeBridge client for `READY` and verify automatic reconnect at the next Windows sign-in.

**If the PC is currently offline**, CodeBridge cannot remotely install the current-user startup entry. That first local one-click action is unavoidable without another already-authorized reachable management channel.
