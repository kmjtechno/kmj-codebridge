# Performance & low-load architecture — agent/gateway poll path

Status: P3/P4/P5 are merged after real VPS before/after benchmarks.
The separate 24×7 Autopilot persistence foundation is wired into `src/agent.js`;
the agent no longer sleeps after a successful dispatch, the gateway empty-poll
wait is controlled by the bounded `pollWaitMs` setting, and connection-state
persistence is transition-only. See `AUTOPILOT.md` for the implemented persistent
queue/checkpoint layer.

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
  moment `forward()` enqueues work for that agent) or the configured
  `pollWaitMs` timeout (clean empty return, no work).
- So wake latency for real work is already ~0ms, not bounded by any poll
  interval. `pollWaitMs` only controls how often an _idle_ agent has to
  re-open a connection.

**The original bug was entirely on the agent side, and it was smaller than it looked:**

```js
// previous src/agent.js loop shape
...
if (!stopped)
  await delay(Math.min(10000, c.pollMs * 2 ** failures), undefined, {
    signal: controller.signal,
  });
```

That delay fired **unconditionally** after every iteration — success,
empty long-poll return, or failure alike. On the success path
`failures` reset to `0`, so the delay collapsed to
`Math.min(10000, pollMs) = pollMs` (default 250ms, per `src/config.js`).
Net effect before the fix:

- Idle cost: negligible — one extra `pollMs` (≤250ms default) tacked onto
  a long-poll cycle, not a busy loop.
- Active cost: every single tool dispatch paid an extra `pollMs` of dead
  time before the agent re-entered `/agent/poll` for the next job. In a
  multi-tool-call agentic session this was a real, measurable tax on
  "maximum safe burst speed" (Phase 8 of the brief), even though it was
  not the idle-load problem it first looked like.

Current behavior: delay/backoff now runs only after a failed poll/dispatch
cycle. Clean success and clean empty long-poll returns immediately re-enter
`/agent/poll`.

License renewal (`renew()`) is also already deadline-driven
(`if (Date.now() < nextRenewal) return;`) — it does not do work on every
loop tick today. No redesign needed there; noted so it is not redone.

`markConnected()` now persists `connection.json` only on a real
**disconnected→connected transition**. Healthy poll/result traffic does not
rewrite the file. A failed gateway cycle marks the in-memory state disconnected,
so the next successful health/poll cycle records the reconnect exactly once.

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

**Implemented safe slice:**

1. In the agent loop, delay-and-backoff now run only after an actual request
   failure (the `catch` branch). After a clean iteration — work dispatched
   _or_ a clean empty long-poll return — the agent loops straight back into
   `/agent/poll` with no added `pollMs` delay.
2. The gateway long-poll timeout is controlled by the bounded
   `pollWaitMs` gateway config field. The default is 45 seconds. This is a
   pure idle-chatter reduction — it cannot add latency to real work,
   because wake is driven by `waiting.get(id)()`, not by the timeout.
3. `connection.json` persistence is now transition-only in P5: healthy
   traffic leaves the file untouched, failures mark the in-memory connection
   state disconnected, and the next successful cycle records one reconnect.
   The regression test first proved the old 30-second time-debounce rewrote
   the file during healthy traffic, then passed after the transition fix.

Measured P3/P4 post-merge result over 120 seconds: combined idle CPU fell from
0.700% to 0.583% (about 16.7%), combined RSS from 181.8 MB to 171.5 MB (about
5.7%), and process-wide agent disk writes from about 8 KB/min to 4,094 B/min
(about 50%). The final post-P5 sample measured agent CPU 0.291%, gateway CPU
0.350%, combined CPU 0.641%, combined RSS 173.4 MB, process-wide agent disk
writes 4,093 B/min, gateway disk writes 0 B/min, and `/healthz` 65.007 ms.
The dedicated P5 regression proves healthy traffic does not rewrite
`connection.json`; `/proc/<pid>/io` is a whole-process counter and therefore is
not a file-specific proof of connection-state writes. These process/health
measurements do not represent a full authenticated client→MCP→agent round trip.

These changes are limited to `src/agent.js`, `src/gateway.js` and
`src/config.js` plus tests/docs. They do not touch `src/jobs.js` or the
sensitive-binding protection in `src/tools.js`.

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

## 4. Phase 7 — CodeBridge Supervisor (implemented foundation)

The restricted Linux Supervisor is implemented and installer-integrated. It
uses the fixed `/run/kmj-codebridge/supervisor.sock` Unix socket, systemd socket
activation, fixed service/config mappings, bounded/redacted logs, config
validation, fixed-filesystem disk-space reporting, and allowlisted service
restart. The MCP dispatcher exposes only the matching typed Supervisor tools;
there is still no arbitrary command, service name, path, environment dump or
credential-return API.

The remaining Supervisor work is deliberately narrower: signed software
update/rollback orchestration, any additional bounded resource/network
diagnostics justified by production evidence, and a Windows equivalent with
the same fail-closed allowlist semantics.

## 5. Phase 8 — self-update / rollback (verification and activation foundation implemented)

Signed release-manifest verification, Ed25519 key selection, archive size/hash
verification, archive-entry safety checks, anti-rollback sequence validation,
immutable release naming/staging, atomic POSIX `current`/`previous` activation,
and bounded release-history/rollback storage are implemented with deterministic
tests.

CodeBridge does **not** yet claim unattended production self-update. The missing
production orchestration is the security-sensitive part: fetch a configured
signed manifest/archive without DNS-rebinding or redirect ambiguity, safely
extract only validated entries, run preflight, activate the immutable release,
restart through the restricted Supervisor, verify health/connectivity, and
automatically restore the previous release on failure. Until that exact flow is
merged and live-tested, installer rerun remains the supported runtime
repair/update mechanism.

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


### Simulated control-plane scale evidence

The benchmark also emits a separate `simulatedScale` section for 1, 10, 100 and
1000 idle-agent metadata entries. This is an **in-process Map/data-structure
simulation**, not a claim that 1000 real networked agents were load-tested. It
measures bounded presence-list scans, heartbeat updates, pending-queue lookups
and deterministic serialized metadata bytes per agent, with deliberately
conservative regression budgets.

This simulation exists to catch accidental algorithmic/control-plane regressions
cheaply in normal CI. Real multi-host and multi-replica load/failover tests remain
a separate production benchmark and must not be inferred from these numbers.
