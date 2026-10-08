import { fail } from "./errors.js";

const MAX_TASKS = 64;
const MAX_POOLS = 12;
const KINDS = new Set(["research", "code", "test", "review", "docs"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function requireValid(value) {
  if (!value) fail("INVALID_HYPERSPEED_PLAN");
}

function validate(tasks, pools) {
  requireValid(
    Array.isArray(tasks) && tasks.length > 0 && tasks.length <= MAX_TASKS,
  );
  requireValid(Array.isArray(pools) && pools.length <= MAX_POOLS);
  const ids = new Set();
  for (const task of tasks) {
    requireValid(task && IDENTIFIER.test(task.id) && !ids.has(task.id));
    ids.add(task.id);
    requireValid(KINDS.has(task.kind));
    requireValid(
      Number.isInteger(task.estimateMinutes) &&
        task.estimateMinutes >= 1 &&
        task.estimateMinutes <= 240,
    );
    requireValid(
      Number.isInteger(task.priority) &&
        task.priority >= 0 &&
        task.priority <= 100,
    );
    requireValid(
      Array.isArray(task.dependsOn) && task.dependsOn.length <= MAX_TASKS,
    );
    requireValid(new Set(task.dependsOn).size === task.dependsOn.length);
    requireValid(Array.isArray(task.paths) && task.paths.length <= 32);
    for (const scope of task.paths) {
      requireValid(
        typeof scope === "string" &&
          scope.length <= 200 &&
          (scope === "*" ||
            (/^[A-Za-z0-9_.\/-]+$/.test(scope) &&
              !scope.split("/").includes("..") &&
              !scope.startsWith("/"))),
      );
    }
  }
  for (const task of tasks) {
    for (const id of task.dependsOn)
      requireValid(ids.has(id) && id !== task.id);
  }
  const visited = new Set();
  const visiting = new Set();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const walk = (id) => {
    if (visiting.has(id)) fail("HYPERSPEED_DEPENDENCY_CYCLE");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependsOn) walk(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) walk(id);
  const poolIds = new Set();
  for (const pool of pools) {
    requireValid(pool && IDENTIFIER.test(pool.id) && !poolIds.has(pool.id));
    poolIds.add(pool.id);
    requireValid(
      Array.isArray(pool.kinds) && pool.kinds.every((kind) => KINDS.has(kind)),
    );
    requireValid(
      Number.isInteger(pool.remainingRequests) &&
        pool.remainingRequests >= 0 &&
        pool.remainingRequests <= 1000000,
    );
    requireValid(
      Number.isInteger(pool.requestsPerMinute) &&
        pool.requestsPerMinute >= 1 &&
        pool.requestsPerMinute <= 100000,
    );
    requireValid(
      (pool.unitCostUsd === 0 && pool.enabled === true) ||
        (pool.unitCostUsd >= 0 && pool.enabled === false),
    );
    requireValid(typeof pool.canProcessPrivateCode === "boolean");
    requireValid(typeof pool.quotaVerified === "boolean");
    requireValid(pool.mode === "cloud" || pool.mode === "local");
  }
  return byId;
}

function overlaps(a, b) {
  if (a.length === 0 || b.length === 0) return true;
  for (const one of a) {
    for (const two of b) {
      if (
        one === "*" ||
        two === "*" ||
        one === two ||
        one.startsWith(two + "/") ||
        two.startsWith(one + "/")
      )
        return true;
    }
  }
  return false;
}

export function planHyperSpeed({ tasks, pools, capacity, allowLocal = false }) {
  const byId = validate(tasks, pools);
  requireValid(capacity && typeof capacity === "object");
  const slots =
    capacity.blocked === true
      ? 0
      : Math.max(
          0,
          Math.min(16, Math.floor(capacity.effectiveMaxConcurrent || 0)),
        );
  const remaining = new Map(
    pools.map((pool) => [pool.id, pool.remainingRequests]),
  );
  const done = new Set();
  const waves = [];
  const reasons = {};
  if (slots === 0) {
    for (const task of tasks) reasons[task.id] = "LICENSE_OR_RESOURCE_BLOCKED";
    return {
      modeledOnly: true,
      quotaEntitlementsVerified: false,
      authorizedSlots: 0,
      waves,
      blocked: reasons,
      note: "No agent executed; signed entitlement and resource-pressure gates remain authoritative.",
    };
  }
  for (
    let turn = 0;
    turn < tasks.length && done.size < tasks.length;
    turn += 1
  ) {
    const ready = tasks
      .filter(
        (task) =>
          !done.has(task.id) && task.dependsOn.every((id) => done.has(id)),
      )
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          b.estimateMinutes - a.estimateMinutes ||
          a.id.localeCompare(b.id),
      );
    const wave = [];
    const waveUsage = new Map();
    for (const task of ready) {
      if (wave.length >= slots) break;
      if (
        wave.some((other) => overlaps(task.paths, byId.get(other.taskId).paths))
      )
        continue;
      const options = pools
        .filter(
          (pool) =>
            pool.enabled &&
            pool.unitCostUsd === 0 &&
            (pool.mode !== "local" || allowLocal) &&
            pool.kinds.includes(task.kind) &&
            (task.dataClass === "public" || pool.canProcessPrivateCode) &&
            (remaining.get(pool.id) ?? 0) > 0 &&
            (waveUsage.get(pool.id) ?? 0) < pool.requestsPerMinute,
        )
        .sort(
          (a, b) =>
            Number(b.quotaVerified) - Number(a.quotaVerified) ||
            remaining.get(b.id) - remaining.get(a.id) ||
            a.id.localeCompare(b.id),
        );
      const selected = options[0];
      if (!selected) {
        reasons[task.id] = "NO_ELIGIBLE_FREE_MODEL";
        continue;
      }
      remaining.set(selected.id, remaining.get(selected.id) - 1);
      waveUsage.set(selected.id, (waveUsage.get(selected.id) ?? 0) + 1);
      wave.push({
        taskId: task.id,
        modelPool: selected.id,
        quotaConfirmedByPlatform: false,
        estimateMinutes: task.estimateMinutes,
      });
      delete reasons[task.id];
    }
    if (!wave.length) break;
    waves.push(wave);
    for (const item of wave) done.add(item.taskId);
  }
  for (const task of tasks) {
    if (!done.has(task.id) && !reasons[task.id]) {
      reasons[task.id] = task.dependsOn.some((id) => !done.has(id))
        ? "DEPENDENCY_WAIT"
        : "FREE_QUOTA_OR_FILE_LOCK";
    }
  }
  return {
    modeledOnly: true,
    quotaEntitlementsVerified: false,
    authorizedSlots: slots,
    scheduledCount: done.size,
    logicalAgentCount: tasks.length,
    waves,
    blocked: reasons,
    note: "Simulation only: no model called, no jobs launched, no provider quotas verified and no signed concurrency changed.",
  };
}
