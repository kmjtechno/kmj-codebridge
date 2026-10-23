# Home Office Calibration Pro — first owner-approved CodeBridge enrollment

**Applies only to:** Windows host `DESKTOP-5FVJMET`, gateway ID `kmj-homeoffice-desktop-5fvjmet`, project `kmj-calibration-pro`. This is **not** Lenovo P720, CineCore, CloudOS or another device.

## Why the previous reconnect stopped

The account can see the Home Office project grant, but gateway reports `GATEWAY_REGISTRATION_MISSING`. The user's read-only recovery reported `ENROLLMENT=NOT_VERIFIED_OR_NOT_CREATED`; the prior launcher then showed an existing agent.json picker. That is not evidence a valid credential was ever installed. A reconnect without a valid credential cannot pair a new device.

## Preconditions

1. On KMJ-elite, production release status must show a reviewed deployment with the **merged public-agent-origin fix**, and pairing redemption must return a validated canonical HTTPS origin. An outdated production release may return `CODEBRIDGE_GATEWAY_UNAVAILABLE`. Never bypass the release guard: the last observed `currentRelease=platform-8070dad72c55`, `expectedCurrentRelease=platform-54142f844c0b`, `readyToActivate=false`.
2. Verify a private, fully installed CodeBridge Git release with Node 24+ and dependencies. Use a clean trusted runtime at an immutable reviewed SHA; do not execute a downloaded script from an untrusted folder.
3. The original owner Calibration Pro Git checkout is `E:\KMJ\Codex\KMJ CalibrationNew`. Dirty/untracked user files are **never cleaned or reset**.

## One-click first pairing

On the **Home Office PC**, not P720, double-click `scripts/windows/PAIR-HOMEOFFICE-CALIBRATION.cmd` in that trusted CodeBridge release, using the normal Windows account. Do not run Administrator.

It checks device and project identity, trusted Git origins, clean CodeBridge runtime, Windows Node 24+, a protected public `/agent/health` route, and previously installed private enrollment in a small set of known device locations. Existing credentials cause a safe stop, not overwrite or re-pair. Use `-CheckOnly` for non-mutating local preflight.

When eligible it requests a short-lived pairing from `https://kmjtechno.com` and prints the HTTPS browser approval link. Only the owner approves the displayed device/project `read/write/execute` scope. The token and other private enrollment data are never printed, copied to another device, or uploaded to GitHub. Private files are stored only inside the current user's `%LOCALAPPDATA%\KMJ-CodeBridge\private\homeoffice-calibration-pro` with owner-only ACLs; create-new prevents secret replacement.

After successful approval it validates credential binding and starts exactly one agent through the already reviewed `CONNECT-CALIBRATION-PRO.ps1` gateway-heartbeat verifier. **Independent account-side `connection_overview` must say `READY`**; a new local process or local heartbeat alone is insufficient.

If the server pairing redemption still fails, report only `HOMEOFFICE_PAIR=BLOCKED_OWNER_APPROVAL_OR_PLATFORM_GATEWAY` and finish server-side guarded deployment and public origin configuration before retrying. Each pairing code is short-lived; starting a pairing request is not an approval or release.

## Continuing Calibration Pro T07

- Use the isolated QA checkout `E:\KMJ\T07-PR15-QA` and **do not modify its original five untracked hardware evidence files**.
- PR #17's signed RGB/YUY2 stride fix, exposure diagnostics and optional dual-BenQ preflight still need exact-head native Windows Debug/Release CTest and 3-frame Lenovo smoke evidence before merging.
- Lenovo perspective USB camera is development-only. CP Plus fisheye hardware certification and frozen T07 optical coverage/reload/safety gates remain separate and must not be weakened.

## Privacy / safety

Never paste `agent.json`, `enrollment.json`, bearer tokens, device code secret, internal environment, private logs or pairing response. Share only non-secret `HOMEOFFICE_PAIR=`, `CALIBRATION_RECONNECT=`, and `connection_overview` status markers. No Windows Time changes, service installation, P720 credential reuse, agent force-kill, Git reset/clean, paid cloud API, automatic production deployment or database edits are part of this launcher.
