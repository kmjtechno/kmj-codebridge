import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubReadiness } from "../src/github-readiness.js";

async function drain() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("an optional slow upstream never blocks liveness or starts parallel probes", async () => {
  let calls = 0;
  let resolveProbe;
  const ready = createGitHubReadiness(
    () => {
      calls++;
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    },
    { now: () => 100, ttlMs: 30000 },
  );

  assert.equal(ready(), false);
  assert.equal(ready(), false);
  await drain();
  assert.equal(calls, 1);
  assert.equal(ready(), false);
  resolveProbe({ full_name: "kmjtechno/kmj-codebridge" });
  await drain();
  assert.equal(ready(), true);
  assert.equal(calls, 1);
});

test("a stale successful GitHub probe fails closed during a retry", async () => {
  let clock = 1000;
  let calls = 0;
  let rejectNext;
  const ready = createGitHubReadiness(
    () => {
      calls++;
      if (calls === 1) return Promise.resolve({});
      return new Promise((_, reject) => {
        rejectNext = reject;
      });
    },
    { now: () => clock, ttlMs: 30000 },
  );

  assert.equal(ready(), false);
  await drain();
  assert.equal(ready(), true);
  clock += 30000;
  assert.equal(ready(), false);
  await drain();
  assert.equal(calls, 2);
  rejectNext(new Error("upstream unavailable"));
  await drain();
  assert.equal(ready(), false);
});

test("disabled GitHub integration has no network probing", () => {
  assert.equal(createGitHubReadiness(null)(), false);
});
