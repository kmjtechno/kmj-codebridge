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

export class JobRunner {
  constructor(
    dir,
    { maxConcurrent = 1, resourceProbe = defaultResourceProbe } = {},
  ) {
    this.dir = dir;
    this.maxConcurrent = maxConcurrent;
    this.resourceProbe = resourceProbe;
    this.jobs = new Map();
    this.active = new Map();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (!/^[a-zA-Z0-9-]+$/.test(j.id) || !j.project || !j.state)
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
    if (this.active.size >= capacity.effectiveMaxConcurrent) fail("JOB_BUSY");
    if (this.jobs.size >= 1000) fail("JOURNAL_FULL");
    const j = {
      id: randomUUID(),
      project,
      gate,
      key,
      fingerprint,
      state: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      output: "",
      truncated: false,
    };
    this.jobs.set(j.id, j);
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
        resolve();
      });
    });
    active.timer = setTimeout(
      () => this.stop(j.id, "timed_out"),
      Math.max(10, Math.min(timeoutMs, 300000)),
    );
    return this.public(j);
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
  public(j) {
    const { key, fingerprint, ...visible } = j;
    return structuredClone(visible);
  }
  list(project, limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail("INVALID_JOB_LIMIT");
    const scoped = [...this.jobs.values()]
      .filter((job) => job.project === project)
      .sort(
        (a, b) =>
          b.startedAt.localeCompare(a.startedAt) ||
          b.id.localeCompare(a.id),
      );
    return {
      project,
      total: scoped.length,
      jobs: scoped.slice(0, limit).map((job) => ({
        id: job.id,
        gate: job.gate,
        state: job.state,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        exitCode: job.exitCode,
        truncated: job.truncated,
      })),
    };
  }
  get(id, project) {
    const j = this.jobs.get(id);
    if (!j || j.project !== project) fail("JOB_NOT_FOUND");
    return this.public(j);
  }
  cancel(id, project) {
    this.get(id, project);
    this.stop(id, "cancelled");
    return this.get(id, project);
  }
  async close() {
    const running = [...this.active.values()];
    for (const id of this.active.keys()) this.stop(id, "interrupted");
    await Promise.all(running.map((a) => a.done));
  }
}
