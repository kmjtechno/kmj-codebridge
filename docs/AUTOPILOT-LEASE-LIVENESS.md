# Autopilot expired lease recovery

A long-running CodeBridge worker uses `hasReady(project, eligible)` to decide
whether it should try to `claim()` a task. Previously only `claim()` expired
timed-out leases. If a project's **only** pending work was an expired
`running` task, `hasReady()` returned false forever. Workers would not call
`claim()`, and the durable task was never recovered without a human action
or agent restart.

Now `hasReady()` expires and atomically persists eligible project leases
**before** checking the ready queue, using the existing attempt, fencing and
dependency-failure rules. Expired and exhausted tasks fail closed. Unexpired
leases are never disturbed; another project cannot recover the wrong task.

`autopilot_status` remains read-only but reports
`expiredRunningLeases` so the dashboard can distinguish a currently
running task from a stale lease while a worker hasn't checked it yet.
A previous mutating recipe checkpoint stays intact and is still respected
by the isolated repair worker's no-replay-on-restart fence.

This source fix does not guarantee the agent service runs 24×7. It requires
an actually installed, started and continuously supervised device-agent
process, plus restart, resource, disk and software-updater evidence.
