# KMJ OpenHands Agent Canvas — P520 deployment candidate

**Status:** source/CI deployment candidate only. Production deployment and live Agent Canvas ↔ CodeBridge MCP OAuth are **not** verified. This is not part of the signed KMJ-elite gateway release.

## Proven upstream version and deployment target

- Official [OpenHands Agent Canvas v1.40.0](https://github.com/OpenHands/OpenHands/releases/tag/v1.40.0) (published 2026-11-12).
- Official [Windows Docker quickstart](https://github.com/OpenHands/OpenHands/blob/v1.40.0/README.windows.md) requires Docker Desktop Linux containers and shows the `ghcr.io/openhands/agent-canvas:1.40.0` image.
- Target **P520**, hostname `DESKTOP-5FVJMET` only. Never install on KMJ-elite's production root, CloudOS, or the primary Main Platform.
- Private localhost-only UI at `http://127.0.0.1:8000/canvas`. No public DNS/Cloudflare/nginx changes.
- Docker named state volume `kmj-openhands-canvas-state` retains settings when the test container is stopped/removed. The only host bind mount is a new isolated workspace under `%LOCALAPPDATA%\KMJ TECHNO\OpenHandsPilot\workspace`.
- Version tag is fixed at 1.40.0; **registry digest and SBOM/signature still need an independent supply-chain review** before high-trust use. No claim of image-byte reproducibility.

## Operator commands on the approved P520 only

Start PowerShell as the normal P520 owner (do **not** use Administrator/RunAs). Docker Desktop must be installed, running Linux containers and using its local `desktop-linux` context.

```powershell
# Read-only — validates host and Docker Desktop; no installation or launch.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\P520-OPENHANDS-CANVAS-PILOT.ps1

# Explicit opt-in: downloads official version and starts a bounded Docker pilot.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\P520-OPENHANDS-CANVAS-PILOT.ps1 -Start

# Read-only Docker container state (not an authentication test).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\P520-OPENHANDS-CANVAS-PILOT.ps1 -Status

# Explicitly stop **only** this labeled test container, preserving named volume.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\P520-OPENHANDS-CANVAS-PILOT.ps1 -Stop
```

If the container is stopped and the dedicated workspace is nonempty, restarting requires a separate review of that folder and an explicit `-Start -ReuseWorkspace`. The script refuses reparse-point directories, existing container name collisions and occupied host port 8000; it never resets or removes a pre-existing source checkout.

**Important:** `-ExecutionPolicy Bypass` applies only to that process; inspect the script and verify its exact GitHub commit before running. Do not launch unknown downloaded scripts. This is not a request to bypass CodeBridge's host approval.

## Docker Desktop missing on P520

If `-Start` reports `OPENHANDS_DOCKER_DESKTOP_MISSING`, it means Docker CLI is not in PATH or the expected local installation directories. This is a dependency failure, **not evidence that Agent Canvas started**.

The launcher now checks Docker Desktop's standard per-user and system-wide CLI paths before returning this error, and rejects a Docker context that points to a remote endpoint.

1. Check Docker Desktop usage terms: free for personal use, education, non-commercial OSS or eligible small businesses (fewer than 250 employees **and** under US$10 million annual revenue). A larger commercial organization needs a paid Docker subscription; **do not install under the zero-cost mandate if not eligible**. Official policy: https://docs.docker.com/desktop/setup/install/windows-install/
2. In the normal P520 PowerShell session, run the official package manager interactively (no silent license acceptance):

   ```powershell
   winget install --id Docker.DockerDesktop --exact --source winget
   ```

3. Launch Docker Desktop from Start Menu, accept the license only if eligible, select Linux containers / WSL 2, and complete any requested Windows feature setup/restart. Do not install an additional Docker Engine/VM automatically.
4. Verify `docker context show` reports `desktop-linux` and `docker info --format '{{.OSType}}'` reports `linux`. If the context is not selected, switch only after confirming it refers to the **local** Docker Desktop Linux engine; never use a remote `DOCKER_HOST`.
5. Re-run `-Start`. If Docker Desktop was already installed but not in PATH, the launcher can now find its local `docker.exe` directly.

The original P520 source checkout has unrelated untracked owner files. Do not use `git clean` or `git reset`; only the exact approved pilot script is updated through CodeBridge.

## Docker Desktop installed, but Linux engine cannot start

If `-Start` reports `OPENHANDS_LINUX_DOCKER_ENGINE_REQUIRED` and Docker CLI says `Docker Desktop is unable to start`, the Docker CLI is installed, but the **local Linux daemon is not ready**. This is not an OpenHands-specific error.

Run the committed **read-only** doctor on P520, with no admin elevation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\P520-OPENHANDS-ENGINE-DOCTOR.ps1
```

The doctor prints categorized Win32 CPU virtualization/SLAT, Windows build, VirtualMachinePlatform and WSL feature state, hypervisor boot status, WSL command status, Docker Desktop service presence, and daemon availability. It does **not** install WSL, enable Windows features, start/stop VMs or services, update software, unregister distributions, reset Docker images/volumes, or reboot.

If virtualization is disabled, review BIOS/UEFI settings with the owner. If Virtual Machine Platform or WSL features are disabled, Windows administrator approval and a reboot may be required to enable them. If the Windows boot hypervisor is off, owner-authorized admin action and reboot may be required. On a Windows VM, check nested virtualization; do not assume its presence.

See [Docker's official startup troubleshooter](https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/topics) and [Microsoft WSL troubleshooting](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting). Don't run `wsl --unregister`, `docker system prune`, factory reset, or overwrite existing Linux distributions to fix this.

## Authentication / free-only setup

1. Open `http://127.0.0.1:8000/canvas` locally after startup. Upstream may require its session API key. Read it **locally** via:
   ```powershell
   docker exec kmj-openhands-canvas-pilot sh -c 'cat "$STATE_DIR/api-key.txt"'
   ```
   Never paste this key into GitHub, ChatGPT or a CodeBridge tool call.
2. In Agent Canvas **Customize → MCP Servers**, configure custom **Streamable HTTP** `https://kmjtechno.com/mcp`, and perform the actual OAuth sign-in. The official v1.40.0 [MCP feature map](https://github.com/OpenHands/OpenHands/blob/v1.40.0/.agents/skills/verify-openhands/references/feature-map/F17-mcp-servers.md) confirms this UI flow. **OAuth/session compatibility with CodeBridge must be proved live**, not inferred from catalog availability.
3. Verify project-scoped CodeBridge device identity, permission responses and read-only tool calls. Do not grant root/Supervisor operations or production-write permissions.
4. Configure one model only **after** verifying route billing/free status and fallback chain independently. No paid inference, paid cloud backend or default agent auto-execution is authorized. The launcher does not configure models.
5. To exercise the workspace skill, use an **approved disposable clone/worktree** in the dedicated mounted workspace. Verify the skill is loaded from `.agents/skills/kmj-openhands/SKILL.md` for new conversations.
6. Test one bounded read-only task, then a feature-branch edit and test-only PR. Verify no unapproved writes or unexpected network/model spend.

## Operational safeguards and recovery

- The script is **off** by default and runs on the named Windows computer only. It checks local Docker Desktop context and Linux engine before any launch.
- No privileged container, host Docker socket, whole-drive bind mount, production credential directory, public port, automatic restarts, paid fallback or external admin account.
- A first start requires an empty isolated workspace. A later restart of a nonempty workspace requires explicit `-ReuseWorkspace` and owner review.
- Container kill/stop does not delete Docker state volume or workspace. To abandon the pilot, stop the labeled test container and leave all data intact until approved retention cleanup.
- The default Docker image can reach the network; outbound traffic must be evaluated during live acceptance. Do not claim it is air-gapped.
- This pilot runs a **single container** consistent with the official Windows quickstart, not per-conversation isolated Docker containers. The workspace is shared within the pilot. Multiple-sandbox mode needs separate WSL2 acceptance.
- **Rollback:** `-Stop`, revert the opt-in pilot PR if necessary, leave production service and signed release untouched.
- The operator must check Docker Desktop licensing/enterprise eligibility separately if applicable; the open-source Agent Canvas license does not determine Docker Desktop licensing.

## Deployment acceptance checklist

- [ ] Exact GitHub PR head and Ubuntu/Windows CI are successful (code-level).
- [ ] Official image provenance and digest reviewed (supply-chain).
- [ ] P520 host, Docker Desktop Linux context, network loopback and resource limits checked (live).
- [ ] Container image starts and Agent Canvas UI accepts a local API key (live).
- [ ] CodeBridge OAuth handshake, tool catalogue, project-scoped read-only tool request and failure responses verified (live).
- [ ] One strictly free model route confirmed against upstream billing controls, no paid fallback (live).
- [ ] Feature branch isolated change/test/PR complete; no production mutation (live).
- [ ] Owner accepts rollback test and release boundary before any broader deployment.

Unit/static gates: `node --test tests/openhands-canvas-interop.test.js tests/openhands-p520-deployment.test.js`.

**No production deployment should occur just because GitHub CI is green.**
