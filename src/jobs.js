import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { fail } from "./errors.js";
import { hash } from "./policy.js";
export function redact(text) {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    );
}
const MIN_FREE_MEMORY_BYTES = 128 * 1024 * 1024;
const MIN_FREE_DISK_BYTES = 512 * 1024 * 1024;
const CONSTRAINED_MEMORY_RATIO = 0.1;
const CONSTRAINED_LOAD_PER_CPU = 1.5;
const JOURNAL_LIMIT = 1000;
const QUEUE_LIMIT = 64;

function defaultResourceProbe(cwd) {
  const stats = fs.statfsSync(cwd);
  const blockSize = Number(stats.bsize);
  const [loadOne] = os.loadavg();
  return {
    cpuCount: Math.max(1, os.cpus().length),
    loadOne,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    freeDiskBytes: Number(stats.bavail) * blockSize,
  };
}

function boundedNonNegative(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function durationMs(job) {
  if (!job.startedAt) return null;
  const start = Date.parse(job.startedAt);
  const end = job.endedAt ? Date.parse(job.endedAt) : Date.now();
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : null;
}

export class JobRunner {
  constructor(
    dir,
    {
      maxConcurrent = 1,
      resourceProbe = defaultResourceProbe,
      recheckIntervalMs = 1000,
    } = {},
  ) {
    if (
      !Number.isInteger(recheckIntervalMs) ||
      recheckIntervalMs < 10 ||
      recheckIntervalMs > 60000
    )
      fail("INVALID_JOB_RECHECK_INTERVAL");
    this.dir = dir;
    this.maxConcurrent = maxConcurrent;
    this.resourceProbe = resourceProbe;
    this.recheckIntervalMs = recheckIntervalMs;
    this.recheckTimer = null;
    this.closed = false;
    this.jobs = new Map();
    this.active = new Map();
    this.pending = new Map();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const journalPath = path.join(dir, file);
      const metadata = fs.lstatSync(journalPath);
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 131072)
        fail("CORRUPT_JOURNAL");
      const fd = fs.openSync(
        journalPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      let j;
      try {
        const current = fs.fstatSync(fd);
        if (!current.isFile() || current.nlink !== 1 || current.size > 131072)
          fail("CORRUPT_JOURNAL");
        try {
          j = JSON.parse(fs.readFileSync(fd, "utf8"));
        } catch {
          fail("CORRUPT_JOURNAL");
        }
      } finally {
        fs.closeSync(fd);
      }
      if (
        !j ||
        typeof j !== "object" ||
        !/^[a-zA-Z0-9-]+$/.test(j.id ?? "") ||
        file !== j.id + ".json" ||
        typeof j.project !== "string" ||
        !j.project ||
        typeof j.state !== "string" ||
        !j.state
      )
        fail("CORRUPT_JOURNAL");
      if (["running", "queued"].includes(j.state)) {
        j.state = "interrupted";
        j.endedAt = new Date().toISOString();
        this.persist(j);
      }
      this.jobs.set(j.id, j);
    }
  }
  persist(j) {
    const target = path.join(this.dir, j.id + ".json"),
      tmp = target + ".tmp";
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(j));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  }
  capacity(cwd = this.dir) {
    let raw;
    try {
      raw = this.resourceProbe(cwd);
    } catch {
      fail("RESOURCE_PROBE_FAILED");
    }
    const cpuCount = Math.max(
      1,
      Math.floor(boundedNonNegative(raw?.cpuCount, 1)),
    );
    const loadOne = boundedNonNegative(raw?.loadOne);
    const totalMemoryBytes = Math.floor(
      boundedNonNegative(raw?.totalMemoryBytes),
    );
    const freeMemoryBytes = Math.floor(
      boundedNonNegative(raw?.freeMemoryBytes),
    );
    const freeDiskBytes = Math.floor(boundedNonNegative(raw?.freeDiskBytes));
    const loadPerCpu = loadOne / cpuCount;
    const memoryFreeRatio =
      totalMemoryBytes > 0 ? freeMemoryBytes / totalMemoryBytes : 0;

    let blockReason = null;
    if (freeDiskBytes < MIN_FREE_DISK_BYTES) blockReason = "LOW_DISK";
    else if (freeMemoryBytes < MIN_FREE_MEMORY_BYTES)
      blockReason = "LOW_MEMORY";

    const constrained =
      blockReason === null &&
      (memoryFreeRatio < CONSTRAINED_MEMORY_RATIO ||
        loadPerCpu >= CONSTRAINED_LOAD_PER_CPU);
    const configuredMaxConcurrent = Math.max(
      1,
      Math.floor(boundedNonNegative(this.maxConcurrent, 1)),
    );
    const effectiveMaxConcurrent = blockReason
      ? 0
      : constrained
        ? 1
        : configuredMaxConcurrent;

    return {
      blocked: blockReason !== null,
      blockReason,
      constrained,
      configuredMaxConcurrent,
      effectiveMaxConcurrent,
      activeJobs: this.active.size,
      queuedJobs: this.pending.size,
      queueLimit: QUEUE_LIMIT,
      journalUsed: this.jobs.size,
      journalLimit: JOURNAL_LIMIT,
      journalRemaining: Math.max(0, JOURNAL_LIMIT - this.jobs.size),
      cpuCount,
      loadOne,
      loadPerCpu,
      totalMemoryBytes,
      freeMemoryBytes,
      memoryFreeRatio,
      freeDiskBytes,
      thresholds: {
        minFreeMemoryBytes: MIN_FREE_MEMORY_BYTES,
        minFreeDiskBytes: MIN_FREE_DISK_BYTES,
        constrainedMemoryFreeRatio: CONSTRAINED_MEMORY_RATIO,
        constrainedLoadPerCpu: CONSTRAINED_LOAD_PER_CPU,
      },
    };
  }

  run({ project, gate, key, cwd, command, args = [], timeoutMs = 30000 }) {
    if (this.closed) fail("JOB_RUNNER_CLOSED");
    if (typeof key !== "string" || key.length < 1 || key.length > 128)
      fail("INVALID_IDEMPOTENCY_KEY");
    const fingerprint = hash(
      JSON.stringify({ project, gate, cwd, command, args, timeoutMs }),
    );
    const existing = [...this.jobs.values()].find(
      (j) => j.project === project && j.key === key,
    );
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT");
      return this.public(existing);
    }
    const capacity = this.capacity(cwd);
    if (capacity.blocked) fail("RESOURCE_PRESSURE");
    if (this.jobs.size >= JOURNAL_LIMIT) fail("JOURNAL_FULL");
    if (this.pending.size >= QUEUE_LIMIT) fail("JOB_QUEUE_FULL");
    const j = {
      id: randomUUID(),
      project,
      gate,
      key,
      fingerprint,
      state: "queued",
      queuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      exitCode: null,
      output: "",
      truncated: false,
    };
    this.jobs.set(j.id, j);
    this.pending.set(j.id, { cwd, command, args, timeoutMs });
    this.persist(j);
    this.drain();
    return this.public(j);
  }

  scheduleRecheck() {
    if (this.closed || this.pending.size === 0 || this.recheckTimer) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      this.drain();
    }, this.recheckIntervalMs);
    this.recheckTimer.unref?.();
  }
  clearRecheck() {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }
  drain() {
    if (this.closed) return;
    let waitingForResources = false;
    for (const [id, spec] of this.pending) {
      let capacity;
      try {
        capacity = this.capacity(spec.cwd);
      } catch {
        waitingForResources = true;
        continue;
      }
      if (capacity.blocked || capacity.constrained)
        waitingForResources = true;
      if (
        capacity.blocked ||
        this.active.size >= capacity.effectiveMaxConcurrent
      )
        continue;
      const j = this.jobs.get(id);
      this.pending.delete(id);
      if (!j || j.state !== "queued") continue;
      this.start(j, spec);
    }
    // A queued job must resume after pressure clears without requiring MCP polling.
    // When all licensed slots are busy, process completion already wakes the queue.
    if (this.pending.size && (waitingForResources || this.active.size === 0))
      this.scheduleRecheck();
    else this.clearRecheck();
  }

  start(j, { cwd, command, args, timeoutMs }) {
    j.state = "running";
    j.startedAt = new Date().toISOString();
    this.persist(j);
    // Deliberately exclude gateway tokens, credentials and inherited application secrets.
    const env = {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      LANG: "C.UTF-8",
      CI: "true",
    };
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const active = {
      child,
      reason: null,
      timer: null,
      killTimer: null,
      done: null,
      raw: "",
    };
    this.active.set(j.id, active);
    const append = (chunk) => {
      const room = 32768 - Buffer.byteLength(active.raw);
      if (chunk.length > room) j.truncated = true;
      if (room > 0) active.raw += chunk.subarray(0, room).toString("utf8");
      j.output = redact(active.raw);
      if (Buffer.byteLength(j.output) > 32768)
        j.output = Buffer.from(j.output).subarray(0, 32764).toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    active.done = new Promise((resolve) => {
      let error = false;
      child.on("error", () => {
        error = true;
      });
      child.on("close", async (code) => {
        clearTimeout(active.timer);
        // Leader close does not imply descendants exited. Complete escalation first.
        if (active.reason && active.killTimer)
          await new Promise((done) => setTimeout(done, 600));
        clearTimeout(active.killTimer);
        j.exitCode = code;
        j.state =
          active.reason ?? (!error && code === 0 ? "succeeded" : "failed");
        j.endedAt = new Date().toISOString();
        this.persist(j);
        this.active.delete(j.id);
        this.drain();
        resolve();
      });
    });
    active.timer = setTimeout(
      () => this.stop(j.id, "timed_out"),
      Math.max(10, Math.min(timeoutMs, 300000)),
    );
  }
  stop(id, reason) {
    const a = this.active.get(id);
    if (!a) return;
    a.reason = reason;
    const kill = (signal) => {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(a.child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          }).on("error", () => a.child.kill());
        } else process.kill(-a.child.pid, signal);
      } catch (e) {
        if (e.code !== "ESRCH") a.child.kill(signal);
      }
    };
    kill("SIGTERM");
    if (!a.killTimer) a.killTimer = setTimeout(() => kill("SIGKILL"), 500);
  }
  queuePosition(id, project) {
    let position = 0;
    for (const pendingId of this.pending.keys()) {
      if (this.jobs.get(pendingId)?.project !== project) continue;
      position++;
      if (pendingId === id) return position;
    }
    return null;
  }
  public(j) {
    const { key, fingerprint, ...visible } = j;
    return structuredClone({
      ...visible,
      queuePosition: j.state === "queued" ? this.queuePosition(j.id, j.project) : null,
      durationMs: durationMs(j),
    });
  }
  list(project, limit = 20, { state = "all", cursor = null } = {}) {
    this.drain();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail("INVALID_JOB_LIMIT");
    const allowedStates = [
      "all",
      "running",
      "queued",
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
      "interrupted",
    ];
    if (!allowedStates.includes(state)) fail("INVALID_JOB_STATE");
    if (
      cursor !== null &&
      (typeof cursor !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(cursor))
    )
      fail("INVALID_JOB_CURSOR");
    const projectJobs = [...this.jobs.values()].filter(
      (job) => job.project === project,
    );
    const summary = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      timed_out: 0,
      interrupted: 0,
    };
    for (const job of projectJobs) {
      if (Object.hasOwn(summary, job.state)) summary[job.state]++;
    }
    const scoped = projectJobs
      .filter((job) => state === "all" || job.state === state)
      .sort((a, b) => {
        const aTime = a.startedAt ?? a.queuedAt ?? "";
        const bTime = b.startedAt ?? b.queuedAt ?? "";
        return bTime.localeCompare(aTime) || b.id.localeCompare(a.id);
      });
    const offset =
      cursor === null ? 0 : scoped.findIndex((job) => job.id === cursor) + 1;
    if (cursor !== null && offset === 0) fail("JOB_CURSOR_NOT_FOUND");
    const page = scoped.slice(offset, offset + limit);
    return {
      project,
      state,
      total: scoped.length,
      summary,
      nextCursor: offset + limit < scoped.length ? page.at(-1).id : null,
      jobs: page.map((job) => ({
        id: job.id,
        gate: job.gate,
        state: job.state,
        queuedAt: job.queuedAt ?? null,
        startedAt: job.startedAt ?? null,
        endedAt: job.endedAt,
        exitCode: job.exitCode,
        truncated: job.truncated,
        queuePosition:
          job.state === "queued" ? this.queuePosition(job.id, project) : null,
        durationMs: durationMs(job),
      })),
    };
  }
  get(id, project) {
    this.drain();
    const j = this.jobs.get(id);
    if (!j || j.project !== project) fail("JOB_NOT_FOUND");
    return this.public(j);
  }
  cancel(id, project) {
    const j = this.jobs.get(id);
    if (!j || j.project !== project) fail("JOB_NOT_FOUND");
    if (this.pending.delete(id)) {
      if (this.pending.size === 0) this.clearRecheck();
      j.state = "cancelled";
      j.endedAt = new Date().toISOString();
      this.persist(j);
      return this.public(j);
    }
    this.stop(id, "cancelled");
    return this.public(j);
  }
  async close() {
    this.closed = true;
    this.clearRecheck();
    for (const id of this.pending.keys()) {
      const j = this.jobs.get(id);
      if (!j) continue;
      j.state = "interrupted";
      j.endedAt = new Date().toISOString();
      this.persist(j);
    }
    this.pending.clear();
    const running = [...this.active.values()];
    for (const id of this.active.keys()) this.stop(id, "interrupted");
    await Promise.all(running.map((a) => a.done));
  }
}
