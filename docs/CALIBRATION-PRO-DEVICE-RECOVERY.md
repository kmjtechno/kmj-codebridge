# KMJ Calibration Pro — existing Windows agent one-click reconnect

The current authorized CodeBridge fleet reported `GATEWAY_REGISTRATION_MISSING` for `kmj-homeoffice-desktop-5fvjmet / kmj-calibration-pro` on 2026-10-23. Source changes, GitHub merges, and a live _other_ device cannot start a powered-off or disconnected Windows PC.

## Owner action once (not a PowerShell command)

On the **same already-enrolled Calibration Pro Windows machine**, from an existing **trusted, fully installed and clean CodeBridge repository release**:

1. Double-click `scripts/windows/CONNECT-CALIBRATION-PRO.cmd` in File Explorer as the normal owner account, not Administrator. **The default launcher now runs Node 24+ directly**, not an unsigned PowerShell script; it neither bypasses nor changes Windows execution policy.
2. Existing **private** `agent.json` is discovered only within fixed owner-private stores. Never upload this file, send it to chat, or select another project's credentials. If none is present, the launcher safely reports `EXISTING_ENROLLMENT_NOT_FOUND`; a new device enrollment is a separate owner-approved Main Platform action **after its corrected release goes live**. For older installations, `CONNECT-CALIBRATION-PRO.ps1` remains an opt-in manual alternative, subject to normal Windows script policy.
3. The launcher validates the exact `kmj-homeoffice-desktop-5fvjmet` device and `kmj-calibration-pro` project, private credential/state directories, canonical HTTPS gateway (anonymous POST must return HTTP 401), product repository origin, clean official CodeBridge runtime HEAD, Node 24+ and existing dependencies. A failed condition returns `BLOCKED` with a bounded code. It does not install or fetch code.
4. If an existing agent lock belongs to a live process, it does not start another and **does not claim gateway authorization**. If there is no live lock, it launches exactly one current-user Node agent, waits for a fresh local authenticated heartbeat, and reports the result. On ambiguous state it fails closed, without stopping or deleting anything.
5. Confirm the independent remote `connection_overview` is `READY`. `ALREADY_RUNNING_LOCALLY` and even `LOCAL_AUTHENTICATED_HEARTBEAT` are not proof of the account-side project grant.

The separate `kmj-p720-calibration-desktop-k3ahhem / kmj-calibration-studio` enrollment is **not** changed, repaired, started or silently reused by this launcher. Neither CineCore nor the existing P720 CodeBridge dev agent is touched. This is current-user reconnect, not 24/7 boot service installation, credential rotation, gateway deployment or supervisor takeover.

## Subsequent CodeBridge-only routine QA

After the agent is truly `READY` and the administrator has **explicitly enabled** `"commandPresets": ["calibration-v4-software-qa"]` only on that approved project, the fixed `run_project_command` profile `calibration_v4_qa:full` with a stable request key creates a SHA-pinned detached QA worktree and executes the project's existing deterministic `tools/verify.py`. Use `get_job_status` and record the exact job/source SHA and PASS/FAIL. No repeated manually typed PowerShell commands or git reset/clean on the owner's working tree.

This is **software-only** evidence. Production needs the real camera/projector, optical coverage and held-out holdout QA, frozen T07 acceptance thresholds, independent Windows source QA, fault injection, reload checks and explicit release authorization. The experimental Lenovo UVC webcam mode in Calibration PR #16 cannot certify the calibrated CP Plus fisheye release. A failing physical scan may not promote or overwrite `release.kmjpkg2`.

## Safety and limitations

- Do not run the launcher from an arbitrary ZIP, untrusted checkout or bare downloaded two-file script: its first-party CodeBridge repository, entrypoint and pinned dependencies must already be present.
- Never delete the active lock, duplicate an agent, grant a new device, weaken the existing license/device authorization or share private logs/credential files.
- Reconnect never installs the merged CodeBridge source onto the offline PC. An outdated installed source still needs independently reviewed, safe update/rollback handling. Developer checkout dirtiness is preserved, but a dirty runtime checkout fails closed.
- Windows self-tests validate syntax and negative scope fixtures; they do not demonstrate physical owner execution, gateway registration or hardware release readiness.
