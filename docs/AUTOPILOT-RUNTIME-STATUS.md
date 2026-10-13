# CodeBridge — Autopilot runtime evidence

Use the read-only MCP action `autopilot_worker_runtime_status` for one
authorized device/project. It distinguishes:

- `configured`: project JSON enables a worker type. **Not** proof it runs.
- `loopStarted`: this connected device-agent process actually created a
  worker-loop handle for that project. It may be `null` on older runtimes.
- `processAvailable`: the instrumented device agent reports its own
  dispatcher/worker process has not entered shutdown.
- `evidence`: `ACTIVE_AGENT_WORKER_HANDLES` or `NOT_INSTRUMENTED`.
- `runtimeVersion`: installed agent binary/source package version.

Worker types: local approved-gate execution, isolated deterministic repair,
read-only exact-SHA GitHub Actions watch and local-model review-only drafts.

This tool does **not** prove the host service automatically starts after
reboot, successful external GitHub/CircleCI polling, a completed code fix,
model inference, CI-green PR or production deployment. Confirm those through
separate signed runtime SHA, service supervisor, CI log, repair checkpoint and
multi-day restart/soak evidence. A feature merged to GitHub without a live
agent upgrade still will not appear in its active tool catalog.

No credentials, environment variable values, patch text, shell commands or
customer data are returned. Existing read permissions and device/project
grants remain enforced.
