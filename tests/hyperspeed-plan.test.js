import test from "node:test";
import assert from "node:assert/strict";
import { planHyperSpeed } from "../src/hyperspeed-plan.js";

const task = (id, overrides = {}) => ({
  id,
  kind: "code",
  estimateMinutes: 12,
  priority: 50,
  dependsOn: [],
  paths: [id],
  dataClass: "private",
  ...overrides,
});
const pool = (id, overrides = {}) => ({
  id,
  kinds: ["code", "test", "research", "review", "docs"],
  enabled: true,
  unitCostUsd: 0,
  remainingRequests: 10,
  requestsPerMinute: 10,
  mode: "cloud",
  canProcessPrivateCode: false,
  quotaVerified: false,
  ...overrides,
});
const plan = (tasks, pools, effectiveMaxConcurrent = 3, extra = {}) =>
  planHyperSpeed({
    tasks,
    pools,
    capacity: { effectiveMaxConcurrent, blocked: false },
    ...extra,
  });

test("never increases licensed slots or claims real execution", () => {
  const result = plan(
    [
      task("alpha", { dataClass: "public" }),
      task("beta", { dataClass: "public" }),
    ],
    [pool("free")],
    1,
  );
  assert.equal(result.authorizedSlots, 1);
  assert.equal(result.waves.length, 2);
  assert.equal(result.scheduledCount, 2);
  assert.equal(result.modeledOnly, true);
  assert.equal(result.quotaEntitlementsVerified, false);
});

test("parallelizes independent paths only when eligible free quotas exist", () => {
  const result = plan(
    [
      task("a", { paths: ["app/a"], dataClass: "public" }),
      task("b", { paths: ["app/b"], dataClass: "public" }),
      task("c", {
        dependsOn: ["a", "b"],
        paths: ["app/c"],
        dataClass: "public",
      }),
    ],
    [pool("free", { remainingRequests: 3 })],
  );
  assert.deepEqual(
    result.waves.map((wave) => wave.length),
    [2, 1],
  );
  assert.equal(result.scheduledCount, 3);
});

test("overlapping file scopes cannot share the same wave", () => {
  const result = plan(
    [
      task("a", { paths: ["app/src"], dataClass: "public" }),
      task("b", { paths: ["app/src/main.ts"], dataClass: "public" }),
    ],
    [pool("free")],
    3,
  );
  assert.deepEqual(
    result.waves.map((wave) => wave.length),
    [1, 1],
  );
});

test("protects private source unless the selected pool is approved for it", () => {
  const denied = plan([task("secret")], [pool("free")]);
  assert.equal(denied.scheduledCount, 0);
  assert.equal(denied.blocked.secret, "NO_ELIGIBLE_FREE_MODEL");
  const accepted = plan(
    [task("secret")],
    [pool("private", { canProcessPrivateCode: true })],
  );
  assert.equal(accepted.scheduledCount, 1);
  assert.equal(accepted.modeledOnly, true);
});

test("paid, unavailable and exhausted model pools never get selected", () => {
  const result = plan(
    [task("a", { dataClass: "public" })],
    [
      pool("paid", { enabled: false, unitCostUsd: 1 }),
      pool("disabled", { enabled: false }),
      pool("empty", { remainingRequests: 0 }),
    ],
  );
  assert.equal(result.scheduledCount, 0);
  assert.equal(result.blocked.a, "NO_ELIGIBLE_FREE_MODEL");
});

test("offline local backup stays off unless explicitly permitted", () => {
  const tasks = [task("a")];
  const providers = [
    pool("local", {
      mode: "local",
      canProcessPrivateCode: true,
    }),
  ];
  assert.equal(plan(tasks, providers).scheduledCount, 0);
  assert.equal(
    plan(tasks, providers, 1, { allowLocal: true }).scheduledCount,
    1,
  );
});

test("never consumes more provider RPM than modeled per wave", () => {
  const result = plan(
    [
      task("a", { dataClass: "public" }),
      task("b", { dataClass: "public" }),
      task("c", { dataClass: "public" }),
    ],
    [pool("limited", { requestsPerMinute: 1, remainingRequests: 3 })],
    3,
  );
  assert.deepEqual(
    result.waves.map((wave) => wave.length),
    [1, 1, 1],
  );
});

test("fails closed on CPU/resource block", () => {
  const result = plan([task("a")], [pool("free")], 8, {
    capacity: { blocked: true, effectiveMaxConcurrent: 8 },
  });
  assert.equal(result.authorizedSlots, 0);
  assert.equal(result.blocked.a, "LICENSE_OR_RESOURCE_BLOCKED");
});

test("rejects aliases that would bypass file-scope mutual exclusion", () => {
  for (const path of [".", "src/", "src//main.js", "src/./main.js"]) {
    assert.throws(
      () => plan([task("a", { paths: [path] })], []),
      /INVALID_HYPERSPEED_PLAN/,
    );
  }
});

test("rejects duplicate ids, missing dependencies, cycles and unsafe scopes", () => {
  assert.throws(
    () => plan([task("a"), task("a")], []),
    /INVALID_HYPERSPEED_PLAN/,
  );
  assert.throws(
    () => plan([task("a", { dependsOn: ["z"] })], []),
    /INVALID_HYPERSPEED_PLAN/,
  );
  assert.throws(
    () =>
      plan(
        [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })],
        [],
      ),
    /HYPERSPEED_DEPENDENCY_CYCLE/,
  );
  assert.throws(
    () => plan([task("a", { paths: ["../../etc/secret"] })], []),
    /INVALID_HYPERSPEED_PLAN/,
  );
});
