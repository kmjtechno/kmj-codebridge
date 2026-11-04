# P520 VIOSO Clone — exact-head read-only rig command onboarding

The owner's P520 `kmj-vioso-clone-r3-desktop-5fvjmet / vioso-clone` is online but currently exposes only `python_verify:test` and `rea_doctor:check`. Neither permits actual desktop inventory. **Connectivity and user permission do not automatically add an administrator-approved command profile.**

## Source fix

CodeBridge now has opt-in `vioso-clone-rig-readonly` preset. The **only** variant `vioso_rig_preflight:displays` executes `python -m vclone rig-preflight --expected-projectors 2` under a bounded 30-second project job. It invokes the clone's M34 read-only Win32 screen rectangle enumerator. It cannot turn on projectors, open camera streams, fetch Git, install software, or start a PowerShell command.

The runner requires an **exact-head clean detached lane**, never the shared checkout. Enabling this preset does not make a stale local Git checkout current. The operator must independently update or create a **clean, verified** VIOSO Clone installation to the desired GitHub main SHA without reset/clean of `E:\KMJ\Codex\VIOSO-Clone`.

## Explicit owner administrator opt-in

After reviewing, testing, merging and installing a trusted CodeBridge release containing this preset, the owner-controlled P520 administrator may edit the *existing private agent configuration* for just the already-authorized `vioso-clone` project by adding this preset ID to its `commandPresets` array. Preserve other project entries, device credentials, token ACLs, existing commands and source path. **Do not replace the full private config using a chat-generated file**:

```json
{
  "id": "vioso-clone",
  "commandPresets": ["vioso-clone-rig-readonly"]
}
```

This is a **field-level illustration**, not a full config. If the enrolled project has other presets, retain them too. The installed agent must validate its private config before it is restarted through the existing owner-approved supervisor process.

When the P520 reports the exact new command from `list_project_commands`, an authorized ChatGPT/IDE client can invoke the fixed variant with `run_project_command` (no shell, arguments or paths):

- `device=kmj-vioso-clone-r3-desktop-5fvjmet`
- `project=vioso-clone`
- `command=vioso_rig_preflight`
- `variant=displays`

Verify the resulting redacted job receipt and only then interpret screen rectangles. Do **not** claim the off projectors are detected: Win32 may report fewer displays when the projectors are OFF. Two distinct extended desktops still require physical left/right mapping by the operator.

## Separate P520 checkout blocker

The shared owner checkout is `feat/sps-container-m5` and contains modified, untracked reverse-engineering notes. `worktree_lane_prepare_cached_main` correctly rejects the stale cached origin/main. It must not be bypassed by `git reset`, `git clean` or by blindly fetching inside the shared checkout. A vetted, one-time, independently created exact-SHA QA clone under a new sibling directory is the preferred owner-safe route, after checking the directory is absent. The independently staged script `P520-VIOSO-M36-ISOLATED-QA-V1.ps1` in the P520 CodeBridge management project is **not** itself an authorized VIOSO command profile and cannot be run by MCP until separately reviewed/approved under its own correct project.

Hardware acceptance remains separate: no live camera RTSP frame, no projector power/scan, no original VIOSO 7 `.sps` compatibility or synchronization guarantee is proved by this preset or GitHub CI.

No additional paid service required.
