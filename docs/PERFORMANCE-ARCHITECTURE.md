# Performance & low-load architecture — agent/gateway poll path

Status: the performance-tuning slices in this document are still design-only.
The separate 24×7 Autopilot persistence foundation is now wired into
`src/agent.js`, but the agent poll-delay logic and gateway long-poll timing
described below remain unchanged pending the real before/after benchmark.
See `AUTOPILOT.md` for the implemented persistent queue/checkpoint layer.

## 1. What is actually there today (read-only inspection, not assumption)

Before designing anything, the current `src/gateway.js` / `src/agent.js`
pair was re-read end to end. The finding changes the scope of this work:

**The gateway side is already an event-driven long-poll, not a busy loop.**

- `forward()` (gateway) enqueues a job into `pending` and, if the target
  agent currently has an open `/agent/poll` request, calls `waiting.get(id)()`
  to resolve it immediately. There is no storage/DB polling loop anywhere
  in the request path.
- `/agent/poll` either returns already-queued work immediately, or opens one
  `Promise` that resolves on whichever happens first: `wake()` (instant, the
  moment `forward()` enqueues work for that agent) or a 10-second
  `setTimeout` (clean empty return, no work).
- So wake latency for real work is already ~0ms, not bounded by any poll
  interval. The 10s figure only controls how often an _idle_ agent has to
  re-open a connection.

**The bug is entirely on the agent side, and it is smaller than it looked:**

```js
// src/agent.js, current loop (unmodified, read-only)
...
if (!stopped)
  try {
    await delay(Math.min(10000, c.pollMs * 2 ** failures), undefined, {
      signal: controller.signal,
    });
  } catch { break; }
```

This delay fires **unconditionally** after every iteration — success,
empty long-poll return, or failure alike. On the success path
`failures` is reset to `0`, so the delay collapses to
`Math.min(10000, pollMs) = pollMs` (default 250ms, per `src/config.js`).
Net effect:

- Idle cost: negligible — one extra `pollMs` (≤250ms default) tacked onto
  a ~10s cycle, not a busy loop.
- Active cost: **every single tool dispatch pays an extra `pollMs` of dead
  time** before the agent re-enters `/agent/poll` for the next job. In a
  multi-tool-call agentic session this is a real, measurable tax on
  "maximum safe burst speed" (Phase 8 of the brief), even though it is not
  the idle-load problem it first looked like.

License renewal (`renew()`) is also already deadline-driven
(`if (Date.now() < nextRenewal) return;`) — it does not do work on every
loop tick today. No redesign needed there; noted so it is not redone.

`markConnected()` already debounces `connection.json` writes to at most
once per 30s of wall time, but it is still **time-debounced, not
transition-debounced** — it writes on a timer-ish cadence driven by poll
traffic, not only on an actual disconnected→connected transition.

## 2. Ruling: keep HTTP long-poll, do not introduce a new persistent-socket protocol

A brand-new persistent outbound connection (WebSocket/HTTP2 stream) was one
of the two options in the brief. Given finding (1), it is rejected for now:

- The existing design already has instant wake and no idle busy-loop — the
  stated goals of Phase 2/3 are already met architecturally.
- A new protocol adds a second connection-lifecycle/reconnect model to
  secure and test, for a benefit (lower per-request HTTP overhead) that is
  unmeasured and likely small next to the real, already-identified
  `pollMs` tax.
- Cost if this ruling is wrong: idle network chatter stays slightly higher
  than a socket-based design would allow. This is recoverable later and is
  a strictly smaller risk than shipping a new transport unverified.

**Smallest safe slice (to implement once authorized, not yet applied):**

1. In the agent loop, only delay-and-backoff after an actual request
   failure (the `catch` branch). After a clean iteration — work dispatched
   _or_ a clean empty long-poll return — loop straight back into
   `/agent/poll` with no added delay. This removes the per-tool-call
   `pollMs` tax entirely; the gateway's 10s timeout is already the only
   idle throttle needed.
2. Raise the gateway long-poll timeout (currently the literal `10000` at
   `src/gateway.js:~303`) toward the 45–60s the brief asks for. This is a
   pure idle-chatter reduction — it cannot add latency to real work,
   because wake is driven by `waiting.get(id)()`, not by the timeout.
   Needs a config knob (new `pollWaitMs` field in `gatewaySchema`,
   bounded, defaulted conservatively) rather than a hardcoded change, to
   stay consistent with how `deviceTimeoutMs`/`pollMs` are already
   exposed in `src/config.js`.
3. Once (1)+(2) land, re-measure `connection.json` write frequency before
   deciding whether transition-only persistence (vs. time-debounced) is
   still worth the extra state-tracking complexity. Likely still worth
   doing, but only backed by a measurement, not a guess.

Both (1) and (2) are single, independently testable changes to
`src/agent.js` / `src/gateway.js` + `src/config.js`. Neither touches
`src/jobs.js` or the sensitive-binding protection in `src/tools.js`.

## 3. Phase 6 — reducing AI round trips

Already available and already the right tools for this: `read_files_batch`,
`write_files_atomic` (just used atomically for the security patch),
`search_code`. No speculative new batch tool is justified yet.

Candidate `project_snapshot` tool (only build if a real multi-call pattern
from actual usage logs justifies it — not speculative):

```
project_snapshot(device, project) -> {
  device, project, writable,
  branch, head, dirty: boolean,
  changedFiles: { modified: number, untracked: number, deleted: number },
  gates: string[],
  runtimeVersion: string
}
```

Deliberately excludes file contents/diffs/full file lists — those stay on
`read_files_batch`/`git_diff`/`list_directory` so the snapshot response
stays small and cheap to call often.

## 4. Phase 7 — CodeBridge Supervisor (spec only, no code yet)

Allowlisted RPCs only, exactly as specified in the brief
(`codebridge_status`, `service_status`, `service_restart`,
`service_reload`, `update_check`, `update`, `rollback`,
`release_history`, `agent_logs`, `gateway_logs`, `config_validate`,
`config_reload`, `disk_space`, `bounded_resource_status`,
`network_diagnostics`). No arbitrary command, executable, service name,
path, env dump or credential access, ever.

- Linux: Unix domain socket, `0700`-owner-only directory /
  `0600` socket, systemd unit, socket-activated where practical so the
  supervisor itself costs nothing while idle.
- Windows: equivalent local named-pipe/service IPC with the same
  allowlist.
- This is new, security-sensitive surface area — it should get its own
  threat-modeled spec and test plan before any implementation, not be
  folded into the long-poll/latency patch.

## 5. Phase 8 — self-update / rollback (spec only, no code yet)

Flow as specified: signed manifest → SHA-256 → Ed25519 signature →
immutable staged release → preflight → atomic `current` symlink swap →
restart → health check → automatic rollback on failure, previous
known-good release retained. No GitHub runner or token required at
runtime; no mutable production git checkout.

This depends on the Supervisor (§4) existing first, since `update`/
`rollback`/`service_restart` are supervisor RPCs. Sequenced after it.

## 6. Benchmark harness semantics (`scripts/benchmark.js`)

Three measurement kinds, deliberately kept separate and separately labeled
in the JSON output — never averaged or conflated with each other:

- **`processIdle`** — `/proc`-based CPU/RSS/disk I/O for the agent and
  gateway OS processes individually (`--agent-match`/`--agent-pid`,
  `--gateway-match`/`--gateway-pid`) plus a `combined` total. Linux only;
  reports `supported: false` with a reason rather than guessing when a
  process can't be identified. CPU/RSS math depends on the kernel's clock
  ticks/second and page size; both are detected via `getconf` when
  available, and the output's `assumptions` object says explicitly whether
  each value was detected or fell back to the documented default
  (100 Hz / 4096 bytes), so a reader never mistakes an assumption for a
  measurement.
- **`dispatcherLocal`** — p50/p95/max latency of calling
  `createDispatcher()` directly against a disposable temp project, for
  every tool the _device dispatcher_ actually implements
  (`inspect_project`, `connection_doctor`, `read_file`,
  `read_file_range`, `read_files_batch`, `search_code`, `git_status`,
  `edit_file`). `list_devices` is deliberately excluded: it is a
  gateway-level operation (`src/gateway.js`) that `createDispatcher`
  rejects with `UNKNOWN_TOOL` (`src/tools.js`) — benchmarking it through
  the dispatcher was an earlier bug in this harness, fixed by removing it
  from this section rather than working around the rejection. This number
  is pure tool-execution cost; it has no MCP, gateway-queue or network
  component.
- **`gatewayMcp`** — only populated when `--gateway=URL` is passed, and
  currently only probes the unauthenticated `/healthz` endpoint. Explicitly
  documented in the output as liveness-only, not a stand-in for the real
  authenticated Claude/ChatGPT → MCP → gateway → agent → tool → result
  path, which this harness does not attempt to measure.

The harness is a single bounded run (one idle sampling window, a fixed
number of dispatcher-timing iterations, then exit) with temp-project
cleanup in a `finally` block and a non-zero exit code plus a stack trace on
failure, so it cannot leave stray `/tmp` state or silently report success
on partial failure, and never adds a second source of idle load itself.
