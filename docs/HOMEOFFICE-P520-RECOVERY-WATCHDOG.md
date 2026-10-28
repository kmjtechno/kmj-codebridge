# HomeOffice P520 signed-in-session recovery watchdog

Status: **source candidate only**. Not installed on P520, not a production or authenticated READY claim.

## Purpose

The existing `ONE-CLICK-AGENT-AUTOCONNECT.ps1 -Device HomeOffice` installs a current-user login shortcut for one approved agent. It does not restart an unexpectedly exited agent while the Windows owner remains signed in. This optional watchdog adds bounded three-minute re-invocation of the already approved `-AtLogon` reconnect helper, which itself rejects unknown enrollment and duplicate agent launches.

Once a **new trusted runtime containing this file** is installed and the owner deliberately invokes the normal HomeOffice one-click, the same one-click automatically invokes `HOMEOFFICE-RECONNECT-WATCHDOG.ps1 -Install`. Old pinned runtimes without this file keep their existing behaviour and output `KMJ_AUTOCONNECT_CRASH_RECOVERY=NOT_INCLUDED_IN_PINNED_RUNTIME`. The watchdog is not activated by the `-AtLogon` auto path.

## Boundaries

- Fixed Windows host `DESKTOP-5FVJMET`; current non-elevated user only.
- Existing clean, tracked local CodeBridge checkout; accepted Git remote is source provenance only, not a download.
- Existing HomeOffice `-AtLogon` path only; no device enrollment, login popups, file picker, credential copies, shell arbitrary arguments, privilege escalation, service, Scheduled Task or machine-wide persistence.
- One exactly scoped current-user Startup shortcut; refuse conflicting preexisting shortcut; verify target, arguments and working directory. Named mutex prevents multiple watchdog loops in one user session. Removing the shortcut stops the loop without killing agent.
- No background operation when Windows user is logged out, PC is sleeping/offline or power is off. A successful local process is not account grant; the gateway must still independently report `connection_overview=READY`.
- Does not replace root-signed production release, browser owner approval, provider JWT/token signing, or automatic stable agent updater.

## Activation prerequisites

First deploy the Main Platform HTTPS readiness and authenticated gateway, complete real owner browser approval, reconnect once, and obtain actual account-side READY. Then roll out reviewed and signed new CodeBridge runtime including watchdog. **Do not swap old pinned P520 checkout to an unreviewed branch.** The next deliberate one-click in that signed runtime registers the watchdog. The current first-party Main Platform launcher still points to the older pinned local runtime commit, so publishing this PR alone does not deliver the watchdog to P520.

## Undo

After a signed new runtime is present, the approved owner may run the watchdog's `-Remove` mode as the same normal Windows user. It verifies the exact shortcut identity, removes only its own Startup entry, and leaves the agent, enrollment, other apps and existing login shortcut unchanged. A running loop exits at its next bounded check. `-SelfTest` never changes Startup.

## Verification

`node --test tests/homeoffice-reconnect-watchdog.test.js tests/windows-oneclick-agent-autostart.test.js` includes static contract checks on all hosts and PowerShell native parser/self-test on Windows. Production device reboot, crash fault-injection, actual task startup, and authenticated connection heartbeat remain separate owner-device evidence.
