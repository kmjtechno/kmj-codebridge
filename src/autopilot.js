import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";

const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const STATES = new Set(["queued", "running", "waiting", ...TERMINAL]);

function cleanText(value, max) {
  if (typeof value !== "string") fail("INVALID_AUTOPILOT_TEXT");
  return redact(value).slice(0, max);
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class AutopilotJournal {
  constructor(dir, { maxTasks = 500 } = {}) {
    this.dir = dir;
    this.maxTasks = maxTasks;
    this.file = path.join(dir, "state.json");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.state = this.load();

    let recovered = false;
    for (const task of this.state.tasks) {
      if (task.state !== "running") continue;
      task.state = "queued";
      task.recoveries = (task.recoveries ?? 0) + 1;
      task.updatedAt = new Date().toISOString();
      task.lastReason = "agent_restart";
      recovered = true;
    }
    if (recovered) this.persist();
  }

  load() {
    if (!fs.existsSync(this.file)) return { version: 1, tasks: [] };
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      fail("CORRUPT_AUTOPILOT_STATE");
    }
    if (
      state?.version !== 1 ||
      !Array.isArray(state.tasks) ||
      state.tasks.length > this.maxTasks ||
      state.tasks.some(
        (task) =>
          !task ||
          typeof task.id !== "string" ||
          !PROJECT.test(task.project ?? "") ||
          !KEY.test(task.key ?? "") ||
          !STATES.has(task.state) ||
          !Array.isArray(task.dependsOn),
      )
    )
      fail("CORRUPT_AUTOPILOT_STATE");
    return state;
  }

  persist() {
    const tmp = this.file + ".tmp";
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  public(task) {
    return structuredClone(task);
  }

  get(id, project) {
    const task = this.state.tasks.find(
      (candidate) => candidate.id === id && candidate.project === project,
    );
    if (!task) fail("AUTOPILOT_TASK_NOT_FOUND");
    return task;
  }

  pruneTerminalForSpace() {
    if (this.state.tasks.length < this.maxTasks) return;
    const protectedIds = new Set(
      this.state.tasks
        .filter((task) => !TERMINAL.has(task.state))
        .flatMap((task) => task.dependsOn),
    );
    const removable = this.state.tasks
      .filter((task) => TERMINAL.has(task.state) && !protectedIds.has(task.id))
      .sort(
        (a, b) =>
          a.updatedAt.localeCompare(b.updatedAt) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
    for (const task of removable) {
      if (this.state.tasks.length < this.maxTasks) break;
      const index = this.state.tasks.findIndex(
        (candidate) => candidate.id === task.id,
      );
      if (index >= 0) this.state.tasks.splice(index, 1);
    }
  }

  enqueue({ project, key, objective, priority = 0, dependsOn = [] }) {
    if (!PROJECT.test(project) || !KEY.test(key))
      fail("INVALID_AUTOPILOT_TASK");
    if (
      !Number.isInteger(priority) ||
      priority < -100 ||
      priority > 100 ||
      !Array.isArray(dependsOn) ||
      dependsOn.length > 20 ||
      dependsOn.some((id) => typeof id !== "string")
    )
      fail("INVALID_AUTOPILOT_TASK");

    const normalized = {
      project,
      key,
      objective: cleanText(objective, 8192),
      priority,
      dependsOn: [...new Set(dependsOn)],
    };
    const fp = fingerprint(normalized);
    const existing = this.state.tasks.find(
      (task) => task.project === project && task.key === key,
    );
    if (existing) {
      if (existing.fingerprint !== fp) fail("AUTOPILOT_IDEMPOTENCY_CONFLICT");
      return this.public(existing);
    }
    this.pruneTerminalForSpace();
    if (this.state.tasks.length >= this.maxTasks)
      fail("AUTOPILOT_JOURNAL_FULL");

    for (const dependency of normalized.dependsOn) {
      const found = this.state.tasks.find(
        (task) => task.id === dependency && task.project === project,
      );
      if (!found) fail("AUTOPILOT_DEPENDENCY_NOT_FOUND");
    }

    const now = new Date().toISOString();
    const task = {
      id: randomUUID(),
      ...normalized,
      fingerprint: fp,
      state: "queued",
      attempts: 0,
      recoveries: 0,
      checkpoint: null,
      lastReason: null,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.tasks.push(task);
    this.persist();
    return this.public(task);
  }

  isReady(task) {
    if (task.state !== "queued") return false;
    return task.dependsOn.every((id) => {
      const dependency = this.state.tasks.find(
        (candidate) =>
          candidate.id === id && candidate.project === task.project,
      );
      return dependency?.state === "succeeded";
    });
  }

  claim(project) {
    const candidates = this.state.tasks
      .filter((task) => task.project === project && this.isReady(task))
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
    const task = candidates[0];
    if (!task) return null;
    task.state = "running";
    task.attempts += 1;
    task.updatedAt = new Date().toISOString();
    task.lastReason = null;
    this.persist();
    return this.public(task);
  }

  checkpoint(id, project, { summary, next }) {
    const task = this.get(id, project);
    if (task.state !== "running") fail("AUTOPILOT_TASK_NOT_RUNNING");
    task.checkpoint = {
      summary: cleanText(summary, 8192),
      next: cleanText(next, 8192),
      at: new Date().toISOString(),
    };
    task.updatedAt = task.checkpoint.at;
    this.persist();
    return this.public(task);
  }

  wait(id, project, reason) {
    const task = this.get(id, project);
    if (task.state !== "running") fail("AUTOPILOT_TASK_NOT_RUNNING");
    task.state = "waiting";
    task.lastReason = cleanText(reason, 4096);
    task.updatedAt = new Date().toISOString();
    this.persist();
    return this.public(task);
  }

  resume(id, project) {
    const task = this.get(id, project);
    if (task.state !== "waiting") fail("AUTOPILOT_TASK_NOT_WAITING");
    task.state = "queued";
    task.lastReason = null;
    task.updatedAt = new Date().toISOString();
    this.persist();
    return this.public(task);
  }

  complete(id, project, { state, result }) {
    if (!TERMINAL.has(state)) fail("INVALID_AUTOPILOT_FINAL_STATE");
    const task = this.get(id, project);
    if (!["running", "waiting"].includes(task.state))
      fail("AUTOPILOT_TASK_NOT_ACTIVE");
    task.state = state;
    task.result = cleanText(result, 8192);
    task.updatedAt = new Date().toISOString();
    this.persist();
    return this.public(task);
  }

  status(project, limit = 50) {
    const tasks = this.state.tasks
      .filter((task) => task.project === project)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const counts = Object.fromEntries(
      [...STATES].map((state) => [
        state,
        tasks.filter((task) => task.state === state).length,
      ]),
    );
    const next = this.state.tasks
      .filter((task) => task.project === project && this.isReady(task))
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      )[0];
    return {
      counts,
      next: next ? this.public(next) : null,
      tasks: tasks
        .slice(0, Math.max(1, Math.min(limit, 100)))
        .map((task) => this.public(task)),
    };
  }
}
