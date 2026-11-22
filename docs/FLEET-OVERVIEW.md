# CodeBridge Fleet Overview (read-only)

The `fleet_overview({maxProjects: 8})` MCP tool provides a single account-granted snapshot of authorized project lanes. This is the first cross-project triage capability for the KMJ HyperSpeed roadmap and is not an autonomous model worker or release gate.

The gateway enumerates only projects granted to the authenticated user's tenant(s), caps requests at twelve projects, and forwards existing `autopilot_status` and `execution_capacity` read calls to **online and authorized** device/project scopes. An unregistered/offline device gets a coded blocker and receives no work. Only task state counts, next task ID, resource-adjusted authorized job slots, and follow-up action codes are returned. No objectives, secrets, arbitrary command, project file contents, raw output or credentials are exposed.

Missing/old agent support produces a fail-closed partial lane, not fabricated success. The `actualAvailableJobSlots` metric does not represent free AI-model inference, or permission to increase an entitlement. No task is automatically executed, no worker scheduled, no provider contacted. Gateway deployment is required for this tool to be live; GitHub merge alone does not activate a new MCP tool.

The new optional `nextWork` section is a **read-only cross-repo handoff**:
it lists at most twelve safe authorized `device + project + taskId` triples,
capped by each device's actual shared available job slots. It never echoes a
task objective, assumes globally comparable priorities, claims jobs or
starts inference. `partialFleet: true` means the scan was truncated. Before
claiming a task, check the owner's latest priorities/pauses and independently
recheck that project's `autopilot_status` and `chat_workspace_open`.

For the zero-extra-cost agent workflow and cross-repo feature coordination,
see [Multi-repo Autopilot](MULTI-REPO-AUTOPILOT.md). This requires a signed
gateway deployment before it can be advertised as live.

Use the output to choose independent project tasks across distinct machines/worktrees, preserving Git head leases, CI protections, billing scope and physical CineCore safety acceptance. See `docs/HYPERSPEED.md` for the bounded single-project planner and model-quota constraints.
