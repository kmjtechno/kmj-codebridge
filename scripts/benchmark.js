#!/usr/bin/env node
// Lightweight benchmark harness — KMJ CodeBridge idle/active performance.
//
// Usage:
//   node scripts/benchmark.js [options]
//
// Options:
//   --idle-seconds=20        Sampling window for idle process metrics.
//   --agent-match=STRING     Substring to match the agent process's cmdline.
//   --gateway-match=STRING   Substring to match the gateway process's cmdline.
//   --agent-pid=PID          Exact agent PID instead of matching by name.
//   --gateway-pid=PID        Exact gateway PID instead of matching by name.
//   --gateway=URL            Base URL to probe for gatewayMcp latency
//                            (/healthz only — see note in output).
//
// Three distinct, separately labeled measurement kinds (do not conflate
// them — see docs/PERFORMANCE-ARCHITECTURE.md):
//
//   processIdle  - CPU/RSS/disk I/O sampled from /proc for the running
//                  agent and gateway OS processes, measured separately and
//                  combined. Requires Linux and the real services running;
//                  reported as unsupported/not-found otherwise, never
//                  guessed.
//   dispatcherLocal - wall-clock latency of calling the tool dispatcher
//                  (src/tools.js createDispatcher) directly, in-process,
//                  against a disposable temp project. This measures only
//                  file/tool execution cost. It does NOT include MCP
//                  transport, gateway queueing/long-poll wake, or the
//                  agent's network round trip, and must never be presented
//                  as end-to-end latency. Only tools the dispatcher itself
//                  implements are benchmarked here — list_devices is a
//                  gateway-level tool (see src/gateway.js) and
//                  createDispatcher deliberately rejects it
//                  (`fail("UNKNOWN_TOOL")`), so it is intentionally
//                  excluded from this section.
//   gatewayMcp   - real network latency against a running gateway, if
//                  --gateway is given. Currently only /healthz is probed
//                  (unauthenticated liveness), which is NOT the same as a
//                  full authenticated Claude/ChatGPT -> MCP -> gateway ->
//                  agent -> tool -> result round trip. Labeled and
//                  documented as such; left unmeasured (not guessed) when
//                  --gateway is not given.
//
// This harness is a single bounded run: it samples, times, prints JSON,
// and exits. It is never a daemon and never samples faster than a fixed
// two-point before/after window, so it does not add meaningful idle load
// itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const idleSeconds = Number(args["idle-seconds"] ?? 20);
const gatewayUrl = args.gateway ? String(args.gateway) : null;

function log(...xs) {
  console.error(...xs);
}

function environmentMetadata() {
  let repoRevision = null;
  try {
    repoRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // A source archive may not contain .git; preserve null rather than guess.
  }
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    repoRevision,
  };
}

// ---------- platform constants: never silently assumed ----------

function detectClockTicksPerSecond() {
  try {
    const out = execFileSync("getconf", ["CLK_TCK"], {
      encoding: "utf8",
    }).trim();
    const n = Number(out);
    if (Number.isFinite(n) && n > 0) return { value: n, assumed: false };
  } catch {
    // getconf not available or failed; fall through to documented default
  }
  return { value: 100, assumed: true };
}

function detectPageSizeBytes() {
  try {
    const out = execFileSync("getconf", ["PAGESIZE"], {
      encoding: "utf8",
    }).trim();
    const n = Number(out);
    if (Number.isFinite(n) && n > 0) return { value: n, assumed: false };
  } catch {
    // getconf not available or failed; fall through to documented default
  }
  return { value: 4096, assumed: true };
}

// ---------- IDLE: process-level sampling via /proc (Linux only) ----------

function findPidsByMatch(matchSubstring) {
  if (process.platform !== "linux" || !matchSubstring) return [];
  const pids = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const cmdline = fs
        .readFileSync(`/proc/${entry}/cmdline`, "utf8")
        .replace(/\0/g, " ")
        .trim();
      if (cmdline.includes(matchSubstring)) pids.push(pid);
    } catch {
      // process exited between readdir and read; skip
    }
  }
  return pids;
}

function fixedServiceMainPid(service) {
  if (process.platform !== "linux") return null;
  try {
    const raw = execFileSync(
      "systemctl",
      ["show", service, "--property", "MainPID", "--value"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return pid;
  } catch {
    return null;
  }
}

function resolveTargetPid(explicitPid, matchSubstring, label, fixedService) {
  if (explicitPid) {
    const pid = Number(explicitPid);
    try {
      fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return { pid, note: null };
    } catch {
      return { pid: null, note: `${label}: PID ${pid} not found in /proc` };
    }
  }
  if (!matchSubstring && fixedService) {
    const pid = fixedServiceMainPid(fixedService);
    if (pid) return { pid, note: null };
  }
  if (!matchSubstring) {
    return {
      pid: null,
      note: `${label}: no --${label}-pid or --${label}-match given`,
    };
  }
  const matches = findPidsByMatch(matchSubstring);
  if (matches.length === 0)
    return {
      pid: null,
      note: `${label}: no process matched "--${label}-match=${matchSubstring}"`,
    };
  if (matches.length > 1)
    return {
      pid: null,
      note: `${label}: ${matches.length} processes matched "--${label}-match=${matchSubstring}" (${matches.join(
        ", ",
      )}) — ambiguous, narrow the match or pass --${label}-pid explicitly`,
    };
  return { pid: matches[0], note: null };
}

function readProcSample(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  // Fields are space-separated; the 2nd field (comm) may itself contain
  // spaces inside parentheses, so split after the last ')'.
  const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const utime = Number(afterComm[11]);
  const stime = Number(afterComm[12]);
  const rssPages = Number(afterComm[21]);
  let io = { readBytes: 0, writeBytes: 0, ioAvailable: true };
  try {
    const text = fs.readFileSync(`/proc/${pid}/io`, "utf8");
    const readBytes = Number(/read_bytes:\s*(\d+)/.exec(text)?.[1] ?? 0);
    const writeBytes = Number(/write_bytes:\s*(\d+)/.exec(text)?.[1] ?? 0);
    io = { readBytes, writeBytes, ioAvailable: true };
  } catch {
    // /proc/pid/io may be permission-restricted; report as unavailable
    // rather than silently reporting zero as if it were measured.
    io = { readBytes: 0, writeBytes: 0, ioAvailable: false };
  }
  return { pid, ticks: utime + stime, rssPages, ...io };
}

function diffSample(before, after, elapsedSec, hz, pageSizeBytes) {
  const cpuSeconds = (after.ticks - before.ticks) / hz;
  return {
    pid: before.pid,
    cpuPercentAvg: Number(((cpuSeconds / elapsedSec) * 100).toFixed(3)),
    rssBytes: after.rssPages * pageSizeBytes,
    rssMB: Number(((after.rssPages * pageSizeBytes) / 1048576).toFixed(1)),
    diskIoAvailable: after.ioAvailable,
    diskReadBytesPerMin: after.ioAvailable
      ? Math.round(((after.readBytes - before.readBytes) / elapsedSec) * 60)
      : null,
    diskWriteBytesPerMin: after.ioAvailable
      ? Math.round(((after.writeBytes - before.writeBytes) / elapsedSec) * 60)
      : null,
  };
}

async function sampleProcessIdle(seconds) {
  const hzInfo = detectClockTicksPerSecond();
  const pageInfo = detectPageSizeBytes();
  const assumptions = {
    clockTicksPerSecond: hzInfo.value,
    clockTicksPerSecondAssumed: hzInfo.assumed,
    pageSizeBytes: pageInfo.value,
    pageSizeBytesAssumed: pageInfo.assumed,
  };
  if (process.platform !== "linux") {
    return {
      supported: false,
      note: `Process-level /proc sampling only implemented for Linux; running on ${process.platform}.`,
      assumptions,
    };
  }
  const agent = resolveTargetPid(
    args["agent-pid"],
    args["agent-match"],
    "agent",
    "kmj-codebridge-agent.service",
  );
  const gateway = resolveTargetPid(
    args["gateway-pid"],
    args["gateway-match"],
    "gateway",
    "kmj-codebridge-gateway.service",
  );
  if (!agent.pid && !gateway.pid) {
    return {
      supported: false,
      note: [agent.note, gateway.note].filter(Boolean).join("; "),
      assumptions,
    };
  }
  const targets = [];
  if (agent.pid) targets.push({ role: "agent", pid: agent.pid });
  if (gateway.pid) targets.push({ role: "gateway", pid: gateway.pid });

  const before = targets.map((t) => ({ ...t, sample: readProcSample(t.pid) }));
  const t0 = Date.now();
  await delay(seconds * 1000);
  const elapsedSec = (Date.now() - t0) / 1000;
  const after = targets.map((t) => ({ ...t, sample: readProcSample(t.pid) }));

  const perRole = {};
  before.forEach((b, i) => {
    perRole[b.role] = diffSample(
      b.sample,
      after[i].sample,
      elapsedSec,
      hzInfo.value,
      pageInfo.value,
    );
  });
  const combined = {
    cpuPercentAvg: Number(
      Object.values(perRole)
        .reduce((s, r) => s + r.cpuPercentAvg, 0)
        .toFixed(3),
    ),
    rssMB: Number(
      Object.values(perRole)
        .reduce((s, r) => s + r.rssMB, 0)
        .toFixed(1),
    ),
    diskReadBytesPerMin: Object.values(perRole).every((r) => r.diskIoAvailable)
      ? Object.values(perRole).reduce((s, r) => s + r.diskReadBytesPerMin, 0)
      : null,
    diskWriteBytesPerMin: Object.values(perRole).every((r) => r.diskIoAvailable)
      ? Object.values(perRole).reduce((s, r) => s + r.diskWriteBytesPerMin, 0)
      : null,
  };
  return {
    supported: true,
    sampledSeconds: elapsedSec,
    assumptions,
    notes: [agent.note, gateway.note].filter(Boolean),
    ...perRole,
    combined,
  };
}

// ---------- ACTIVE (dispatcherLocal): direct dispatcher timing ----------

async function timeIt(label, n, fn) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((x, y) => x - y);
  const pick = (p) =>
    samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  return {
    label,
    n,
    p50ms: Number(pick(0.5).toFixed(3)),
    p95ms: Number(pick(0.95).toFixed(3)),
    maxMs: Number(samples[samples.length - 1].toFixed(3)),
  };
}

async function sampleDispatcherLocal() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const { createDispatcher } = await import(
    path.join(repoRoot, "src", "tools.js")
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-bench-"));
  try {
    fs.writeFileSync(path.join(root, "hello.txt"), "hello world\n".repeat(50));
    fs.writeFileSync(
      path.join(root, "notes.md"),
      "# notes\n" + "some searchable text\n".repeat(200),
    );
    let gitOk = true;
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "-A"], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.email=a@b.c",
          "-c",
          "user.name=bench",
          "commit",
          "-q",
          "-m",
          "init",
        ],
        { cwd: root },
      );
    } catch {
      gitOk = false;
    }
    const config = {
      id: "bench",
      projects: [{ id: "p1", root, writable: true, gates: {} }],
    };
    const runner = { maxConcurrent: 1 };
    const licenseProvider = () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    });
    const dispatch = createDispatcher(config, runner, licenseProvider);
    const a = (extra) => ({ device: "bench", project: "p1", ...extra });

    const results = [];
    // Only tools the device dispatcher itself implements. list_devices is
    // gateway-level (src/gateway.js) and createDispatcher intentionally
    // rejects it with UNKNOWN_TOOL, so it is never benchmarked here.
    results.push(
      await timeIt("inspect_project", 20, () =>
        dispatch("inspect_project", a({}), ["read"]),
      ),
    );
    results.push(
      await timeIt("connection_doctor", 20, () =>
        dispatch("connection_doctor", a({}), ["read"]),
      ),
    );
    results.push(
      await timeIt("read_file", 20, () =>
        dispatch("read_file", a({ path: "hello.txt" }), ["read"]),
      ),
    );
    results.push(
      await timeIt("read_file_range", 20, () =>
        dispatch(
          "read_file_range",
          a({ path: "notes.md", startLine: 1, maxLines: 20 }),
          ["read"],
        ),
      ),
    );
    results.push(
      await timeIt("read_files_batch", 20, () =>
        dispatch(
          "read_files_batch",
          a({ files: [{ path: "hello.txt" }, { path: "notes.md" }] }),
          ["read"],
        ),
      ),
    );
    results.push(
      await timeIt("search_code", 20, () =>
        dispatch("search_code", a({ query: "searchable" }), ["read"]),
      ),
    );
    if (gitOk) {
      results.push(
        await timeIt("git_status", 20, () =>
          dispatch("git_status", a({}), ["read"]),
        ),
      );
    }
    // edit_file: a fresh scratch file per sample so the unique-oldText
    // precondition holds; never touches a sensitive binding.
    {
      const samples = [];
      for (let i = 0; i < 20; i++) {
        const relPath = `scratch-${i}.txt`;
        fs.writeFileSync(path.join(root, relPath), "line-one\n");
        const before = await dispatch("read_file", a({ path: relPath }), [
          "read",
        ]);
        const t0 = performance.now();
        await dispatch(
          "edit_file",
          a({
            path: relPath,
            oldText: "line-one",
            newText: "line-one-edited",
            expectedHash: before.sha256,
          }),
          ["write"],
        );
        samples.push(performance.now() - t0);
      }
      samples.sort((x, y) => x - y);
      const pick = (p) =>
        samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
      results.push({
        label: "edit_file",
        n: samples.length,
        p50ms: Number(pick(0.5).toFixed(3)),
        p95ms: Number(pick(0.95).toFixed(3)),
        maxMs: Number(samples[samples.length - 1].toFixed(3)),
      });
    }
    return results;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------- gatewayMcp: real network probe, liveness only ----------

async function sampleGatewayMcp() {
  if (!gatewayUrl) return { measured: false, note: "no --gateway given" };
  try {
    const t0 = performance.now();
    const res = await fetch(new URL("/healthz", gatewayUrl));
    await res.text();
    return {
      measured: true,
      healthzMs: Number((performance.now() - t0).toFixed(3)),
      note:
        "measures the unauthenticated /healthz round trip only — this is " +
        "NOT the same as an authenticated Claude/ChatGPT -> MCP -> gateway " +
        "-> agent -> tool -> result cycle, which is not measured by this " +
        "harness.",
    };
  } catch (e) {
    return { measured: false, note: `gateway unreachable: ${e.message}` };
  }
}

async function main() {
  const out = {
    generatedAt: new Date().toISOString(),
    environment: environmentMetadata(),
    processIdle: null,
    dispatcherLocal: null,
    gatewayMcp: null,
  };

  log(`processIdle: sampling for ${idleSeconds}s...`);
  out.processIdle = await sampleProcessIdle(idleSeconds);

  log(
    "dispatcherLocal: timing dispatcher operations against a temp project...",
  );
  out.dispatcherLocal = await sampleDispatcherLocal();

  log("gatewayMcp: probing /healthz if --gateway was given...");
  out.gatewayMcp = await sampleGatewayMcp();

  console.log(JSON.stringify(out, null, 2));

  log("\n--- summary ---");
  if (out.processIdle.supported) {
    for (const role of ["agent", "gateway"]) {
      if (out.processIdle[role]) {
        const r = out.processIdle[role];
        log(
          `processIdle.${role} (pid ${r.pid}): cpu avg ${r.cpuPercentAvg}%, rss ${r.rssMB}MB, disk w ${r.diskWriteBytesPerMin ?? "n/a"}B/min, disk r ${r.diskReadBytesPerMin ?? "n/a"}B/min`,
        );
      }
    }
    log(
      `processIdle.combined: cpu avg ${out.processIdle.combined.cpuPercentAvg}%, rss ${out.processIdle.combined.rssMB}MB`,
    );
    if (
      out.processIdle.assumptions.clockTicksPerSecondAssumed ||
      out.processIdle.assumptions.pageSizeBytesAssumed
    )
      log(
        `processIdle: NOTE — CPU/RSS use an assumed (not detected via getconf) constant; see "assumptions" in the JSON output.`,
      );
  } else {
    log(`processIdle: not measured — ${out.processIdle.note}`);
  }
  for (const r of out.dispatcherLocal) {
    log(
      `dispatcherLocal.${r.label}: p50 ${r.p50ms}ms, p95 ${r.p95ms}ms, max ${r.maxMs}ms`,
    );
  }
  log(
    out.gatewayMcp.measured
      ? `gatewayMcp./healthz: ${out.gatewayMcp.healthzMs}ms (liveness only, not full MCP round trip)`
      : `gatewayMcp: not measured — ${out.gatewayMcp.note}`,
  );
}

main().catch((e) => {
  log("benchmark failed:", e?.stack ?? String(e));
  process.exitCode = 1;
});
