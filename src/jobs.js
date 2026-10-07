import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
export class JobRunner {
  constructor(dir, { maxConcurrent = 1 } = {}) {
    this.dir = dir;
    this.maxConcurrent = maxConcurrent;
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
  run({
    project,
    gate,
    key,
    cwd,
    command,
    args = [],
    timeoutMs = 30000,
    validateStart = () => {},
  }) {
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
    if (this.active.size >= this.maxConcurrent) fail("JOB_BUSY");
    if (this.jobs.size >= 1000) fail("JOURNAL_FULL");
    // Admission checks apply only to new jobs, never idempotent replays.
    validateStart();
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
