import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelFailoverPolicy } from "../src/model-failover-policy.js";

const local = {
  id: "ollama-qwen",
  provider: "ollama",
  kind: "local",
  free: true,
  privateCodeAllowed: true,
  contextWindow: 8192,
  capabilities: ["coding", "reasoning"],
};
const freeCloud = {
  id: "groq-free",
  provider: "groq",
  kind: "cloud",
  free: true,
  privateCodeAllowed: true,
  contextWindow: 16000,
  capabilities: ["coding"],
};
const paid = {
  id: "paid-fast",
  provider: "paid",
  kind: "cloud",
  free: false,
  privateCodeAllowed: true,
  contextWindow: 100000,
  capabilities: ["coding"],
};
const denied = {
  id: "cloud-no-private",
  provider: "other",
  kind: "cloud",
  free: true,
  privateCodeAllowed: false,
  contextWindow: 20000,
  capabilities: ["coding"],
};
const task = { capability: "coding", inputTokens: 100, maxOutputTokens: 200 };

test("local first even if cloud has larger context and quota", () => {
  const policy = new ModelFailoverPolicy([freeCloud, local, paid]);
  assert.equal(
    policy.select({ ...task, cloudApproved: true }).modelId,
    local.id,
  );
});

test("no cloud without explicit approval; never select paid", () => {
  const policy = new ModelFailoverPolicy([freeCloud, paid]);
  assert.equal(policy.select(task).modelId, null);
  assert.equal(
    policy.select({ ...task, cloudApproved: true }).modelId,
    freeCloud.id,
  );
  const onlyPaid = new ModelFailoverPolicy([paid]);
  assert.equal(onlyPaid.select({ ...task, cloudApproved: true }).modelId, null);
});

test("private code cannot go to a non-authorized cloud provider", () => {
  const policy = new ModelFailoverPolicy([denied]);
  assert.equal(policy.select({ ...task, cloudApproved: true }).modelId, null);
  assert.equal(
    policy.select({ ...task, cloudApproved: true, privateCode: false }).modelId,
    denied.id,
  );
});

test("quota headers prevent requests before running out", () => {
  const policy = new ModelFailoverPolicy([freeCloud]);
  policy.observe(freeCloud.id, {
    statusCode: 200,
    headers: {
      "x-ratelimit-remaining-requests": "2",
      "x-ratelimit-remaining-tokens": "250",
    },
  });
  assert.equal(policy.select({ ...task, cloudApproved: true }).modelId, null);
  assert.equal(policy.status(freeCloud.id).remainingTokens, 250);
  policy.observe(freeCloud.id, {
    statusCode: 200,
    headers: { "X-RateLimit-Remaining-Tokens": "400" },
  });
  assert.equal(
    policy.select({ ...task, cloudApproved: true }).modelId,
    freeCloud.id,
  );
});

test("429 Retry-After causes cooldown then eventual recovery", () => {
  let now = 1_000_000;
  const policy = new ModelFailoverPolicy([freeCloud], { now: () => now });
  policy.observe(freeCloud.id, {
    statusCode: 429,
    headers: { "Retry-After": "40" },
  });
  assert.equal(policy.select({ ...task, cloudApproved: true }).modelId, null);
  now += 39_000;
  assert.equal(policy.select({ ...task, cloudApproved: true }).modelId, null);
  now += 1_000;
  assert.equal(
    policy.select({ ...task, cloudApproved: true }).modelId,
    freeCloud.id,
  );
});

test("fallback keeps bounded context intact instead of truncation", () => {
  const policy = new ModelFailoverPolicy([local, freeCloud]);
  assert.equal(
    policy.select({ ...task, inputTokens: 9000, cloudApproved: true }).modelId,
    freeCloud.id,
  );
  assert.equal(
    policy.select({ ...task, inputTokens: 19000, cloudApproved: true }).modelId,
    null,
  );
});

test("restored quota snapshot does not contain credentials", () => {
  const policy = new ModelFailoverPolicy([freeCloud]);
  policy.observe(freeCloud.id, {
    statusCode: 200,
    headers: { "x-ratelimit-remaining-requests": "3" },
  });
  const restored = new ModelFailoverPolicy([freeCloud], {
    state: policy.snapshot(),
  });
  assert.equal(restored.status(freeCloud.id).remainingRequests, 3);
  assert.equal(JSON.stringify(policy.snapshot()).includes("apiKey"), false);
});

test("invalid configuration and task budget fail closed", () => {
  assert.throws(
    () => new ModelFailoverPolicy([{ ...local, id: "bad id" }]),
    /INVALID_CONFIG/,
  );
  assert.throws(() => new ModelFailoverPolicy([local, local]), /DUPLICATE_ID/);
  const policy = new ModelFailoverPolicy([local]);
  assert.throws(
    () => policy.select({ ...task, inputTokens: -1 }),
    /INVALID_TASK/,
  );
});

test("an auth error pauses a provider; 429 doesn't approve paid fallback", () => {
  let now = 10_000;
  const policy = new ModelFailoverPolicy([freeCloud, paid], { now: () => now });
  policy.observe(freeCloud.id, { statusCode: 401 });
  assert.equal(policy.select({ ...task, cloudApproved: true }).modelId, null);
  now += 3_600_000;
  assert.equal(
    policy.select({ ...task, cloudApproved: true }).modelId,
    freeCloud.id,
  );
});

test("observed zero quota recovers after provider-reported reset window", () => {
  let now = 2_000_000;
  const policy = new ModelFailoverPolicy([freeCloud], { now: () => now });
  policy.observe(freeCloud.id, {
    statusCode: 200,
    headers: {
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "1m20s",
    },
  });
  assert.equal(policy.select({ ...task, cloudApproved: true }).modelId, null);
  now += 80_000;
  assert.equal(
    policy.select({ ...task, cloudApproved: true }).modelId,
    freeCloud.id,
  );
});
