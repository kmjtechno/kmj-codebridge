# Signed update maintenance

Signed update and rollback now share one root-owned Linux maintenance lease.
This coordinates orderly service restarts; it does not isolate the agent from
hostile processes running as the same Unix user. Agent-owned state, job
processes and the existing authenticated-connection evidence already share
that trust boundary. Release signatures and immutable root-owned runtimes
remain separate requirements.

## Restart contract

1. Acquire the exclusive lease before reading the accepted sequence or release
   links. A second update or rollback fails closed. Downloads and staging use
   the `prepare` phase, so ordinary work continues.
2. Atomically change the intent to `drain` after staging succeeds. The agent
   stops new MCP operations, job submissions and autonomous task claims.
   Existing active/queued jobs finish. Worker completion bookkeeping and
   in-flight async worker ticks must finish too. Tool result delivery is part
   of the in-flight operation.
3. The agent acknowledges the unique request only when its entire process is
   idle. The updater checks that acknowledgement against `agent.lock`, Linux
   boot/start identity and the Supervisor's active agent PID. Missing, busy or
   unsupported agents produce `UPDATE_AGENT_BUSY_OR_UNSUPPORTED` after a bounded
   wait; release links and accepted sequence remain unchanged.
4. Hold the intent through activation, health checks and recovery. A replacement
   agent checks the same intent before accepting work. Keep the existing exact
   signed runtime identity and fresh authenticated reconnect requirements.
5. Release the lease on every ordinary exit. If the updater dies, agents recognize
   its dead process or changed boot/start identity and resume admission. A stale
   root lease remains for operator inspection and blocks further updater runs;
   it is never silently stolen. The complete nonempty lease directory is
   published atomically, so a crash cannot expose a partially written intent.

## Host integration

Both updater units need the same dedicated directory:

```ini
RuntimeDirectory=kmj-codebridge-update
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes
ReadWritePaths=/run/kmj-codebridge-update
```

Append the writable path to their existing runtime/state/work allowances. The
fixed intent is `/run/kmj-codebridge-update/maintenance/request.json`; agents
only read it. Agent acknowledgements stay inside the private agent state.
No additional supervisor operations or project command permissions are added.
Linux `/proc` visibility is required. Windows agent operation is unchanged;
this automatic Linux update protocol is unavailable on Windows.

Signed replacement and rollback runtimes must advertise
`codebridgeAgentUpdateProtocol: 1` in their archive-covered `package.json`;
legacy targets fail before release links change. This is a versioned vendor
compatibility contract, not a new trust boundary.

An older agent cannot acknowledge this protocol. Its first migration requires
an operator-controlled maintenance deployment; do not enable a timer and assume
that it can safely bootstrap an unsupported running agent. Likewise, a pinned
manifest URL only checks that exact release: a separately verified signed
channel publication mechanism is required to discover future releases.

## Verification boundary

Tests cover concurrent updater rejection, busy deferral before link mutation,
active/queued jobs finishing, paused worker claims, completion bookkeeping,
result delivery and replacement-agent admission. Real process-death tests run
where the Linux process namespace is visible. Generated unit configuration is
checked; native systemd activation and the host's signed release channel still
require on-host canaries before enabling an update timer.
