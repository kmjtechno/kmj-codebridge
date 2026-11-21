# KMJ CodeBridge — one-click device onboarding (fleet-wide)

This is a common entrypoint for existing and new approved **Windows** and
**Linux/systemd** CodeBridge devices. It is not tied to a particular device
name, KMJ product, or project directory. It is not a universal arbitrary
root/PowerShell executor; supervisor and agent takeovers remain separately gated.

## Windows: one double-click

From a trusted CodeBridge checkout with Node.js 24+ and Git installed,
double-click **KMJ-ONE-CLICK.cmd**. Drag a project Git root onto the file
to select an exact project without a picker. The launcher checks its own
committed Git object IDs, then stages the exact source SHA under a separate
per-user managed-runtime directory with lifecycle scripts disabled.
**An unrelated dirty development checkout is never cleaned, reset or changed.**
It then uses the existing scripts/windows/ONE-CLICK-ANY-DEVICE.ps1 wizard:
already paired on this PC → reconnect the single matching approved agent;
new project/device → ask for scoped owner approval in official HTTPS browser;
after local heartbeat → register exact current-user startup shortcut.
Existing enrollments are not copied or reissued; conflicting agents/locks
and foreign host identity block rather than replacing a running process.

## Linux VPS and desktop with systemd

From a trusted, tracked-clean CodeBridge checkout, run:

```bash
bash KMJ-ONE-CLICK.sh --project /absolute/existing/git-project
```

The launcher elevates through local sudo only if required. With an exact
matching private config and active CodeBridge systemd agent it performs **no
installation, restart or token rotation**. A mismatched or inactive previous
enrollment blocks and requires separate repair review. Existing agent IDs
must match the local hostname; foreign-device credentials are refused. On a fresh device
without a service/config, it invokes the existing guarded official Linux
installer pinned to the _current reviewed checkout SHA_, deriving device
identity from Git project ID and current host. Owner must approve the
short-lived pairing code in the official browser. A successful local service
reports KMJ_DEVICE_ONE_CLICK=PASS, but is not account-level READY proof.

## Scope, safety and operational acceptance

- New device = new independent device grant and explicit browser approval.
- Existing device = preserve exact existing agent, token and project scope.
- No owner file cleanup, token export, unbounded remote shell or paid inference.
- P520 disabled Supervisor + HMAC preparation has its own separate reviewed
  activation path. One-click pairing does NOT silently enable that task or
  restart the existing agent/OmniDesk.
- Supported now: Windows workstations and Linux hosts with systemd. macOS,
  Android, iOS, machines without the required runtime/source and unreachable
  hosts need separate signed installers or platform-specific onboarding.
- Windows fresh-device prerequisite: Node.js 24+, Git and a trusted checkout;
  the launcher itself installs runtime dependencies in its isolated directory.
  Not yet a standalone MSI/MSIX or zero-prerequisite installer.
- Linux first run requires sudo plus outbound internet and supported package
  manager; this is one operator action, not a GUI double-click on headless VPS.
- After onboarding, confirm exact device/project in authenticated
  `connection_overview`; local process state alone cannot prove cloud READY.

Tests: tests/one-click-universal-fleet.test.js runs synthetic Linux selftests
and Windows native pairing selftests in GitHub CI. No physical new-device
enrollment or live server approval is implied by source CI.
