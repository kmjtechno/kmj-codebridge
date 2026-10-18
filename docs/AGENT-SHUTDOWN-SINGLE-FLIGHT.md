# Agent shutdown single-flight hardening

The live P720 CodeBridge agent currently runs with its original owner private
enrollment, a disabled S4U task, and a Windows native Supervisor whose restart
capability remains unavailable. The Stage-0 Windows SCM host and child
lifecycle fixture are source/CI proofs, not a deployed service.

The agent's `close()` previously ran its worker drain and `agent.lock`
release each time it was called. Independent Windows/SCM control paths will
eventually need a reliable **single owner** shutdown result.

This source change:

- Coalesces concurrent and repeat `close()` calls into one cleanup Promise.
- Runs normal `activity.close()`, abort, agent loop drain, all worker
  `close()` operations and runner cleanup **once**.
- Releases the existing state lock only at its existing successful end of
  the sequence. On rejection, retains the same failed promise and never
  claims shutdown success or retries cleanup destructively.
- Makes the CLI `SIGINT`/`SIGTERM` handler report a fixed, non-secret
  failure and nonzero exitCode on rejected cleanup, instead of producing
  an unhandled async exception or unconditionally claiming successful
  teardown. It does **not** force-kill any process or print the
  underlying exception.
- Adds unit tests for concurrent requests, repeated requests, rejected
  cleanup and original agent/CLI contract.

This is a **prerequisite** for trustworthy cooperative service shutdown,
not a Windows SCM stop implementation or P720 production takeover. No
enrollment, task, Windows service, agent process, dirty checkout or
private ACL is touched by merging this change.

Remaining gates: authenticated service-owned shutdown IPC on Windows,
job-drain receipt, identity enrollment and exclusive owner lease,
fresh server-observed heartbeat and rollback under failure.

See [P720 Windows SCM service host](P720-WINDOWS-SCM-SERVICE-HOST.md)
and [issue #393](https://github.com/kmjtechno/kmj-codebridge/issues/393).
