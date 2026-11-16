import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelFailoverPolicy } from "../src/model-failover-policy.js";
import { planSmartModelRoute } from "../src/smart-model-router.js";

const cloud = (id, extra = {}) => ({
  id,
  provider: id.split("/")[0].replace(/[^a-z0-9]/gi, ""),
  kind: "cloud",
  free: true,
  privateCodeAllowed: true,
  contextWindow: 32000,
  capabilities: ["coding"],
  ...extra,
});
const OR = cloud("openrouter/x:free", {
  limits: { perMinute: 20, perDay: 50 },
});
const GQ = cloud("groq/y");
const task = { inputTokens: 100, maxOutputTokens: 100, cloudApproved: true };
const T0 = Date.UTC(2026, 10, 16, 10, 0, 0);
const attested = (m) => ({
  ...m,
  enabled: true,
  health: "ok",
  modelsDiscoveredAtMs: T0 - 1000,
  freeTierVerified: true,
  costPerMillionTokensUsd: 0,
});
const clock = (start = T0) => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
};
const hit = (policy, id, n, c, status = 200, headers = null) => {
  for (let i = 0; i < n; i += 1) {
    policy.observe(id, { statusCode: status, headers });
    c?.advance(4000);
  }
};

test("declared per-day limit moves traffic away before the 429", () => {
  const c = clock();
  const p = new ModelFailoverPolicy([OR, GQ], { now: c.now });
  // Neutral order is by id (groq before openrouter): force openrouter first.
  assert.equal(p.select({ ...task, excluded: [GQ.id] }).modelId, OR.id);
  hit(p, OR.id, 41, c); // 9 of 50 left = 18%, still above 15%
  assert.equal(p.status(OR.id).headroom, "ok");
  hit(p, OR.id, 2, c); // 7 left = 14% -> low
  assert.equal(p.status(OR.id).headroom, "low");
  const pick = p.select(task);
  assert.equal(pick.modelId, GQ.id);
  assert.equal(pick.headroom, "ok");
  // Still usable as last resort while not exhausted.
  const last = p.select({ ...task, excluded: [GQ.id] });
  assert.equal(last.modelId, OR.id);
  assert.equal(last.headroom, "low");
  hit(p, OR.id, 7, c);
  assert.equal(p.select({ ...task, excluded: [GQ.id] }).modelId, null);
});

test("per-minute window slides and recovers", () => {
  const c = clock();
  const p = new ModelFailoverPolicy([OR], { now: c.now });
  hit(p, OR.id, 20);
  assert.equal(p.select(task).modelId, null);
  c.advance(61_000);
  assert.equal(p.select(task).modelId, OR.id);
  assert.equal(p.status(OR.id).requestsUsedToday, 20);
});

test("the daily counter resets at the UTC day boundary", () => {
  const c = clock(Date.UTC(2026, 10, 16, 23, 40, 0));
  const p = new ModelFailoverPolicy([OR], { now: c.now });
  hit(p, OR.id, 50, c); // 200 s apart in total, still the 16th
  assert.equal(new Date(c.now()).getUTCDate(), 16);
  assert.equal(p.select(task).modelId, null);
  c.advance(30 * 60_000);
  assert.equal(new Date(c.now()).getUTCDate(), 17);
  assert.equal(p.select(task).modelId, OR.id);
  assert.equal(p.status(OR.id).requestsUsedToday, 0);
});

test("provider headers drive headroom when the limit header is present", () => {
  const c = clock();
  const p = new ModelFailoverPolicy([GQ, OR], { now: c.now });
  p.observe(GQ.id, {
    statusCode: 200,
    headers: {
      "x-ratelimit-remaining-requests": "10",
      "x-ratelimit-limit-requests": "100",
    },
  });
  assert.equal(p.status(GQ.id).headroom, "low");
  assert.equal(p.select(task).modelId, OR.id);
  // Without a limit header a tiny remainder still counts as low.
  const q = new ModelFailoverPolicy([GQ], { now: c.now });
  q.observe(GQ.id, {
    statusCode: 200,
    headers: { "x-ratelimit-remaining-requests": "2" },
  });
  assert.equal(q.status(GQ.id).headroom, "low");
  q.observe(GQ.id, {
    statusCode: 200,
    headers: { "x-ratelimit-remaining-requests": "50" },
  });
  assert.equal(q.status(GQ.id).headroom, "ok");
});

test("load spreads toward the provider with more headroom", () => {
  const c = clock();
  const A = cloud("aaa/m", { limits: { perDay: 100 } });
  const B = cloud("bbb/m", { limits: { perDay: 100 } });
  const p = new ModelFailoverPolicy([A, B], { now: c.now });
  assert.equal(p.select(task).modelId, A.id);
  hit(p, A.id, 30, c);
  assert.equal(p.select(task).modelId, B.id);
  hit(p, B.id, 60, c);
  assert.equal(p.select(task).modelId, A.id);
});

test("counters survive a snapshot/restore and bad state is sanitised", () => {
  const c = clock();
  const p = new ModelFailoverPolicy([OR], { now: c.now });
  hit(p, OR.id, 45, c);
  const restored = new ModelFailoverPolicy([OR], {
    now: c.now,
    state: p.snapshot(),
  });
  assert.equal(restored.status(OR.id).requestsUsedToday, 45);
  assert.equal(restored.status(OR.id).headroom, "low");
  const junk = new ModelFailoverPolicy([OR], {
    now: c.now,
    state: {
      [OR.id]: {
        dayKey: "x",
        dayCount: -5,
        hits: ["a", c.now() + 99999, 1],
        limitRequests: "9",
      },
    },
  });
  assert.equal(junk.status(OR.id).requestsUsedToday, 0);
  assert.equal(junk.status(OR.id).headroom, "ok");
});

test("invalid limits and headroom are rejected", () => {
  for (const limits of [
    null,
    [],
    { perDay: 0 },
    { perDay: 1.5 },
    { perHour: 5 },
    { perMinute: 2_000_000 },
  ])
    assert.throws(
      () => new ModelFailoverPolicy([cloud("a/b", { limits })]),
      /MODEL_POLICY_INVALID_CONFIG/,
    );
  for (const headroom of [-0.1, 1, "0.1", NaN])
    assert.throws(
      () => new ModelFailoverPolicy([GQ], { headroom }),
      /MODEL_POLICY_INVALID_CONFIG/,
    );
});

test("the planner demotes a nearly exhausted model and advises switching", () => {
  const c = clock();
  const seed = new ModelFailoverPolicy([OR, GQ], { now: c.now });
  hit(seed, OR.id, 45, c);
  const plan = planSmartModelRoute({
    models: [attested(OR), attested(GQ)],
    nowMs: c.now(),
    state: seed.snapshot(),
    task: { ...task, privateCode: false, strategy: "verified-free-cloud-only" },
  });
  assert.equal(plan.selected.modelId, GQ.id);
  assert.equal(plan.fallbacks[0].modelId, OR.id);
  assert.equal(plan.fallbacks[0].lowHeadroom, true);
  assert.equal(plan.rotateAdvised, false); // no current model given
  const onlyLowFirst = planSmartModelRoute({
    models: [attested(OR), attested(GQ)],
    nowMs: c.now(),
    state: seed.snapshot(),
    task: {
      ...task,
      privateCode: false,
      strategy: "verified-free-cloud-only",
      capability: "coding",
    },
  });
  assert.equal(onlyLowFirst.localFallbackAllowed, false);
  const lone = planSmartModelRoute({
    models: [attested(OR)],
    nowMs: c.now(),
    state: seed.snapshot(),
    task: { ...task, privateCode: false, strategy: "verified-free-cloud-only" },
  });
  assert.equal(lone.selected.lowHeadroom, true);
  assert.equal(lone.rotateAdvised, false); // nothing healthy to move to
  assert.equal(lone.modelExecution, "NOT_EXECUTED");
});

test("a running task on a low-headroom model is advised to rotate", () => {
  const c = clock();
  const seed = new ModelFailoverPolicy([OR, GQ], { now: c.now });
  hit(seed, OR.id, 45, c);
  const base = {
    models: [attested(OR), attested(GQ)],
    nowMs: c.now(),
    state: seed.snapshot(),
  };
  const t = {
    ...task,
    privateCode: false,
    strategy: "verified-free-cloud-only",
  };
  const onLow = planSmartModelRoute({
    ...base,
    task: { ...t, currentModelId: OR.id },
  });
  assert.equal(onLow.rotateAdvised, true);
  assert.equal(onLow.selected.modelId, GQ.id);
  const onHealthy = planSmartModelRoute({
    ...base,
    task: { ...t, currentModelId: GQ.id },
  });
  assert.equal(onHealthy.rotateAdvised, false);
  for (const bad of ["", "a b", 5, "../x"])
    assert.throws(
      () =>
        planSmartModelRoute({ ...base, task: { ...t, currentModelId: bad } }),
      /SMART_MODEL_ROUTER_INVALID_TASK/,
    );
});
