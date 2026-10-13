import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";

const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const STATES = new Set(["queued", "running", "waiting", ...TERMINAL]);
const MISSION_TASK_KEY = /^[A-Za-z0-9._-]{1,64}$/;
const AI_BUDGETS = new Set(["economical", "balanced", "maximum_assurance"]);
// Human-readable worker/session labels may include a bounded slash or #
// (e.g. Claude Code/P720 #1); they are metadata, never file paths or keys.
const HOLDER = /^[A-Za-z0-9._:@\/# -]{1,96}$/;
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const MIN_LEASE_MS = 60 * 1000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

function cleanText(value, max) {
  if (typeof value !== "string") fail("INVALID_AUTOPILOT_TEXT");
  return redact(value).slice(0, max);
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class AutopilotJournal {
  constructor(
    dir,
    {
      maxTasks = 500,
      maxAttempts = 10,
      leaseMs = DEFAULT_LEASE_MS,
      now = Date.now,
    } = {},
  ) {
    this.dir = dir;
    this.maxTasks = maxTasks;
    this.maxAttempts = maxAttempts;
    // A claim is a time-bounded lease, so a chat or worker that disconnects
    // cannot hold a task in `running` forever. Checkpoints renew it.
    this.leaseMs = Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, leaseMs));
    this.now = now;
    this.file = path.join(dir, "state.json");
    this.needsMigration = false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.state = this.load();

    let recovered = false;
    const exhausted = [];
    for (const task of this.state.tasks) {
      if (task.state !== "running") continue;
      delete task.lease;
      task.recoveries = (task.recoveries ?? 0) + 1;
      task.updatedAt = new Date().toISOString();
      if (task.attempts >= this.maxAttempts) {
        task.state = "failed";
        task.result = `gave up after ${task.attempts} attempts`;
        task.lastReason = "max_attempts_exceeded";
        exhausted.push(task);
      } else {
        task.state = "queued";
        task.lastReason = "agent_restart";
      }
      recovered = true;
    }
    for (const task of exhausted) this.failDependents(task, "failed");
    if (recovered || this.needsMigration) this.persist();
  }

  load() {
    if (!fs.existsSync(this.file))
      return { version: 2, tasks: [], missions: [] };
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      fail("CORRUPT_AUTOPILOT_STATE");
    }
    const validTasks =
      Array.isArray(state?.tasks) &&
      state.tasks.length <= this.maxTasks &&
      state.tasks.every(
        (task) =>
          task &&
          typeof task.id === "string" &&
          PROJECT.test(task.project ?? "") &&
          KEY.test(task.key ?? "") &&
          STATES.has(task.state) &&
          Array.isArray(task.dependsOn),
      );
    if (!validTasks) fail("CORRUPT_AUTOPILOT_STATE");

    if (state.version === 1) {
      this.needsMigration = true;
      return { version: 2, tasks: state.tasks, missions: [] };
    }

    if (
      state.version !== 2 ||
      !Array.isArray(state.missions) ||
      state.missions.length > 200 ||
      state.missions.some(
        (mission) =>
          !mission ||
          typeof mission.id !== "string" ||
          !PROJECT.test(mission.project ?? "") ||
          !KEY.test(mission.key ?? "") ||
          typeof mission.fingerprint !== "string" ||
          !Array.isArray(mission.acceptanceCriteria) ||
          !Array.isArray(mission.taskSpecs) ||
          typeof mission.taskIds !== "object" ||
          mission.taskIds === null ||
          !Array.isArray(mission.evidence),
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

  // The lease token is a fencing token returned only to the claimant; other
  // readers see who holds a task and until when, never the token itself.
  public(task) {
    const { lease, leasedEver: _leasedEver, ...rest } = structuredClone(task);
    if (lease)
      rest.lease = { holder: lease.holder, expiresAt: lease.expiresAt };
    return rest;
  }

  leaseExpired(task, current = this.now()) {
    return (
      task.state === "running" &&
      task.lease !== undefined &&
      Date.parse(task.lease.expiresAt) <= current
    );
  }

  // Return running tasks whose lease expired to the queue (or fail them once
  // attempts are exhausted). Tasks claimed before leases existed have no lease
  // and keep the previous restart-only recovery.
  expireLeases(project) {
    const current = this.now();
    const exhausted = [];
    let changed = false;
    for (const task of this.state.tasks) {
      if (task.project !== project || !this.leaseExpired(task, current))
        continue;
      delete task.lease;
      task.recoveries = (task.recoveries ?? 0) + 1;
      task.updatedAt = new Date(current).toISOString();
      if (task.attempts >= this.maxAttempts) {
        task.state = "failed";
        task.result = `gave up after ${task.attempts} attempts`;
        task.lastReason = "max_attempts_exceeded";
        exhausted.push(task);
      } else {
        task.state = "queued";
        task.lastReason = "lease_expired";
      }
      changed = true;
    }
    for (const task of exhausted) this.failDependents(task, "failed");
    return changed;
  }

  // A task that has ever been claimed under lease-aware code must present a
  // matching token on every running-state operation: a missing token is
  // exactly as unsafe as a stale one, because it would let a second holder
  // (or the original holder after its lease expired and was re-claimed)
  // silently overwrite another holder's checkpoint or result.
  //
  // Compatibility is preserved only for a genuinely legacy task: one still
  // `running` from before this feature existed, whose claim() therefore
  // never set `leasedEver`. Such a task has no lease and no fencing to
  // enforce; it keeps the previous (pre-lease) behavior until it next
  // transitions through claim(), after which it is fenced like any other.
  assertLease(task, leaseToken) {
    if (!task.leasedEver) return;
    if (
      typeof leaseToken !== "string" ||
      task.lease?.token !== leaseToken ||
      !Number.isFinite(Date.parse(task.lease.expiresAt)) ||
      Date.parse(task.lease.expiresAt) <= this.now()
    )
      fail("AUTOPILOT_LEASE_LOST");
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
    for (const dependency of normalized.dependsOn) {
      const found = this.state.tasks.find(
        (task) => task.id === dependency && task.project === project,
      );
      if (!found) fail("AUTOPILOT_DEPENDENCY_NOT_FOUND");
    }
    this.pruneTerminalForSpace();
    if (this.state.tasks.length >= this.maxTasks)
      fail("AUTOPILOT_JOURNAL_FULL");

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

  hasReady(project, eligible) {
    if (typeof eligible !== "function") fail("INVALID_AUTOPILOT_FILTER");
    return this.state.tasks.some(
      (task) =>
        task.project === project &&
        this.isReady(task) &&
        eligible(this.public(task)),
    );
  }

  claim(project, { holder, eligible = null } = {}) {
    if (eligible !== null && typeof eligible !== "function")
      fail("INVALID_AUTOPILOT_FILTER");
    if (
      holder !== undefined &&
      (typeof holder !== "string" || !HOLDER.test(holder))
    )
      fail("INVALID_AUTOPILOT_HOLDER");
    const expired = this.expireLeases(project);
    const candidates = this.state.tasks
      .filter(
        (task) =>
          task.project === project &&
          this.isReady(task) &&
          (eligible === null || eligible(this.public(task))),
      )
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
    const task = candidates[0];
    if (!task) {
      if (expired) this.persist();
      return null;
    }
    const current = this.now();
    task.state = "running";
    task.attempts += 1;
    task.updatedAt = new Date(current).toISOString();
    task.lastReason = null;
    // Persists for the life of the task (never cleared by wait/complete),
    // so assertLease can always tell a lease-aware task from a genuinely
    // legacy one, even after the lease itself is released.
    task.leasedEver = true;
    task.lease = {
      token: randomUUID(),
      holder: holder ?? null,
      expiresAt: new Date(current + this.leaseMs).toISOString(),
    };
    this.persist();
    return { ...this.public(task), leaseToken: task.lease.token };
  }

  checkpoint(id, project, { summary, next, leaseToken }) {
    const task = this.get(id, project);
    if (task.state !== "running") fail("AUTOPILOT_TASK_NOT_RUNNING");
    this.assertLease(task, leaseToken);
    if (task.lease)
      task.lease.expiresAt = new Date(this.now() + this.leaseMs).toISOString();
    task.checkpoint = {
      summary: cleanText(summary, 8192),
      next: cleanText(next, 8192),
      at: new Date().toISOString(),
    };
    task.updatedAt = task.checkpoint.at;
    this.persist();
    return this.public(task);
  }

  wait(id, project, reason, leaseToken) {
    const task = this.get(id, project);
    if (task.state !== "running") fail("AUTOPILOT_TASK_NOT_RUNNING");
    this.assertLease(task, leaseToken);
    delete task.lease;
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

  complete(id, project, { state, result, leaseToken }) {
    if (!TERMINAL.has(state)) fail("INVALID_AUTOPILOT_FINAL_STATE");
    const task = this.get(id, project);
    if (!["running", "waiting"].includes(task.state))
      fail("AUTOPILOT_TASK_NOT_ACTIVE");
    if (task.state === "running") this.assertLease(task, leaseToken);
    // Once a lease-aware worker pauses, its token is released. Finishing a
    // waiting task without resuming and claiming it would bypass fencing.
    if (task.state === "waiting" && task.leasedEver)
      fail("AUTOPILOT_TASK_NOT_RUNNING");
    delete task.lease;
    task.state = state;
    task.result = cleanText(result, 8192);
    task.updatedAt = new Date().toISOString();
    if (state !== "succeeded") this.failDependents(task, state);
    this.persist();
    return this.public(task);
  }

  failDependents(failedTask, state) {
    const now = new Date().toISOString();
    const queue = [failedTask.id];
    const seen = new Set(queue);
    while (queue.length) {
      const id = queue.shift();
      for (const candidate of this.state.tasks) {
        if (
          candidate.project !== failedTask.project ||
          seen.has(candidate.id) ||
          TERMINAL.has(candidate.state) ||
          !candidate.dependsOn.includes(id)
        )
          continue;
        seen.add(candidate.id);
        candidate.state = "failed";
        candidate.result = `dependency ${id} ended as ${state}`;
        candidate.lastReason = "dependency_failed";
        candidate.updatedAt = now;
        queue.push(candidate.id);
      }
    }
  }

  compileMission({
    project,
    key,
    objective,
    acceptanceCriteria = [],
    requirements = {},
    tasks = [],
    ownerGates = [],
    definitionOfDone,
    aiBudget = "balanced",
  }) {
    if (!PROJECT.test(project) || !KEY.test(key)) fail("INVALID_MISSION");
    if (
      !AI_BUDGETS.has(aiBudget) ||
      !Array.isArray(acceptanceCriteria) ||
      acceptanceCriteria.length > 30 ||
      !Array.isArray(ownerGates) ||
      ownerGates.length > 20 ||
      !Array.isArray(tasks) ||
      tasks.length < 1 ||
      tasks.length > 50
    )
      fail("INVALID_MISSION");

    const cleanList = (values, maxItems, maxChars) => {
      if (!Array.isArray(values) || values.length > maxItems)
        fail("INVALID_MISSION");
      return values.map((value) => cleanText(value, maxChars));
    };
    const normalizedRequirements = {};
    for (const name of [
      "security",
      "reliability",
      "performance",
      "documentation",
    ])
      normalizedRequirements[name] = cleanList(
        requirements?.[name] ?? [],
        20,
        512,
      );

    const normalizedTasks = tasks.map((task) => {
      if (
        !task ||
        !MISSION_TASK_KEY.test(task.key ?? "") ||
        !Array.isArray(task.dependsOn) ||
        task.dependsOn.length > 20 ||
        task.dependsOn.some(
          (dependency) => !MISSION_TASK_KEY.test(dependency),
        ) ||
        !Number.isInteger(task.priority ?? 0) ||
        (task.priority ?? 0) < -100 ||
        (task.priority ?? 0) > 100
      )
        fail("INVALID_MISSION_TASK");
      return {
        key: task.key,
        objective: cleanText(task.objective, 8192),
        priority: task.priority ?? 0,
        dependsOn: [...new Set(task.dependsOn)],
      };
    });
    const taskKeys = new Set(normalizedTasks.map((task) => task.key));
    if (taskKeys.size !== normalizedTasks.length)
      fail("DUPLICATE_MISSION_TASK");
    for (const task of normalizedTasks)
      if (
        task.dependsOn.includes(task.key) ||
        task.dependsOn.some((dependency) => !taskKeys.has(dependency))
      )
        fail("INVALID_MISSION_DEPENDENCY");

    const remaining = new Map(
      normalizedTasks.map((task) => [task.key, new Set(task.dependsOn)]),
    );
    const topological = [];
    while (remaining.size) {
      const ready = [...remaining.entries()]
        .filter(([, dependencies]) => dependencies.size === 0)
        .map(([taskKey]) => taskKey)
        .sort();
      if (!ready.length) fail("MISSION_DEPENDENCY_CYCLE");
      for (const taskKey of ready) {
        topological.push(taskKey);
        remaining.delete(taskKey);
        for (const dependencies of remaining.values())
          dependencies.delete(taskKey);
      }
    }

    const normalized = {
      project,
      key,
      objective: cleanText(objective, 8192),
      acceptanceCriteria: cleanList(acceptanceCriteria, 30, 1024),
      requirements: normalizedRequirements,
      taskSpecs: normalizedTasks,
      ownerGates: cleanList(ownerGates, 20, 1024),
      definitionOfDone: cleanText(definitionOfDone, 4096),
      aiBudget,
    };
    const fp = fingerprint(normalized);
    let mission = this.state.missions.find(
      (candidate) => candidate.project === project && candidate.key === key,
    );
    if (mission) {
      if (mission.fingerprint !== fp) fail("MISSION_IDEMPOTENCY_CONFLICT");
      this.materializeMission(mission, topological);
      return this.missionStatus(mission.id, project);
    }

    if (this.state.missions.length >= 200) fail("MISSION_JOURNAL_FULL");
    const now = new Date().toISOString();
    mission = {
      id: randomUUID(),
      ...normalized,
      fingerprint: fp,
      taskIds: {},
      evidence: normalized.acceptanceCriteria.map(() => null),
      createdAt: now,
      updatedAt: now,
    };
    this.state.missions.push(mission);
    this.persist();
    this.materializeMission(mission, topological);
    return this.missionStatus(mission.id, project);
  }

  materializeMission(mission, topological = null) {
    const order =
      topological ??
      (() => {
        const remaining = new Map(
          mission.taskSpecs.map((task) => [task.key, new Set(task.dependsOn)]),
        );
        const result = [];
        while (remaining.size) {
          const ready = [...remaining.entries()]
            .filter(([, dependencies]) => dependencies.size === 0)
            .map(([taskKey]) => taskKey)
            .sort();
          if (!ready.length) fail("CORRUPT_MISSION_DAG");
          for (const taskKey of ready) {
            result.push(taskKey);
            remaining.delete(taskKey);
            for (const dependencies of remaining.values())
              dependencies.delete(taskKey);
          }
        }
        return result;
      })();

    const byKey = new Map(mission.taskSpecs.map((task) => [task.key, task]));
    for (const taskKey of order) {
      if (mission.taskIds[taskKey]) continue;
      const spec = byKey.get(taskKey);
      const dependencyIds = spec.dependsOn.map(
        (dependency) => mission.taskIds[dependency],
      );
      if (dependencyIds.some((id) => !id)) fail("CORRUPT_MISSION_DAG");
      const journalKey =
        "mission:" + mission.fingerprint.slice(0, 12) + ":" + spec.key;
      const task = this.enqueue({
        project: mission.project,
        key: journalKey,
        objective: spec.objective,
        priority: spec.priority,
        dependsOn: dependencyIds,
      });
      mission.taskIds[taskKey] = task.id;
      mission.updatedAt = new Date().toISOString();
      this.persist();
    }
  }

  getMission(id, project) {
    const mission = this.state.missions.find(
      (candidate) => candidate.id === id && candidate.project === project,
    );
    if (!mission) fail("MISSION_NOT_FOUND");
    return mission;
  }

  missionStatus(id, project) {
    const mission = this.getMission(id, project);
    const tasks = mission.taskSpecs.map((spec) => {
      const taskId = mission.taskIds[spec.key] ?? null;
      const task = taskId
        ? this.state.tasks.find(
            (candidate) =>
              candidate.id === taskId && candidate.project === project,
          )
        : null;
      return {
        key: spec.key,
        taskId,
        objective: spec.objective,
        priority: spec.priority,
        dependsOn: [...spec.dependsOn],
        state: task?.state ?? "pending_materialization",
        result: task?.result ?? null,
        checkpoint: task?.checkpoint ?? null,
      };
    });
    const allMaterialized = tasks.every((task) => task.taskId !== null);
    const allSucceeded =
      allMaterialized && tasks.every((task) => task.state === "succeeded");
    const anyFailed = tasks.some((task) =>
      ["failed", "cancelled"].includes(task.state),
    );
    const anyWaiting = tasks.some((task) => task.state === "waiting");
    const evidenceComplete = mission.evidence.every(
      (entry) => typeof entry === "string" && entry.length > 0,
    );
    const state = anyFailed
      ? "failed"
      : allSucceeded && evidenceComplete
        ? "succeeded"
        : allSucceeded
          ? "evidence_pending"
          : anyWaiting
            ? "waiting"
            : "active";
    return structuredClone({
      id: mission.id,
      project: mission.project,
      key: mission.key,
      objective: mission.objective,
      acceptanceCriteria: mission.acceptanceCriteria,
      requirements: mission.requirements,
      ownerGates: mission.ownerGates,
      definitionOfDone: mission.definitionOfDone,
      aiBudget: mission.aiBudget,
      evidence: mission.evidence,
      evidenceComplete,
      state,
      tasks,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    });
  }

  missionEvidence(id, project, criterionIndex, evidence) {
    const mission = this.getMission(id, project);
    if (
      !Number.isInteger(criterionIndex) ||
      criterionIndex < 0 ||
      criterionIndex >= mission.acceptanceCriteria.length
    )
      fail("MISSION_CRITERION_NOT_FOUND");
    mission.evidence[criterionIndex] = cleanText(evidence, 4096);
    mission.updatedAt = new Date().toISOString();
    this.persist();
    return this.missionStatus(id, project);
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
