import test from "node:test";
import assert from "node:assert/strict";
import {
  createGitHubReadiness,
  readinessErrorCode,
} from "../src/github-readiness.js";
import { CodeBridgeError } from "../src/errors.js";

async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// Timers are injected so tests never wait in real time.
function manualTimers() {
  const pending = new Set();
  return {
    setTimer(fn) {
      const timer = { fn };
      pending.add(timer);
      return timer;
    },
    clearTimer(timer) {
      pending.delete(timer);
    },
    fireAll() {
      for (const timer of [...pending]) {
        pending.delete(timer);
        timer.fn();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

test("an optional slow upstream never blocks liveness or starts parallel probes", async () => {
  let calls = 0;
  let resolveProbe;
  const timers = manualTimers();
  const ready = createGitHubReadiness(
    () => {
      calls++;
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    },
    { now: () => 100, ttlMs: 30000, ...timers },
  );

  assert.equal(ready(), false);
  assert.equal(ready(), false);
  assert.deepEqual(ready.status(), { state: "checking", checking: true });
  await drain();
  assert.equal(calls, 1);
  resolveProbe({ full_name: "kmjtechno/kmj-codebridge" });
  await drain();
  assert.equal(ready(), true);
  assert.equal(calls, 1);
  assert.equal(timers.size, 0, "probe timeout timer is cleared");
  assert.deepEqual(ready.status(), {
    state: "ready",
    checking: false,
    lastResultAgeSeconds: 0,
  });
});

// Regression for issue #274: healthy GitHub was reported not ready on every
// /healthz request spaced more than ttlMs apart, because each refresh reset
// readiness to false before probing.
test("a fresh success stays readable while its refresh runs", async () => {
  let clock = 1000;
  let calls = 0;
  let resolveNext;
  const ready = createGitHubReadiness(
    () => {
      calls++;
      if (calls === 1) return Promise.resolve({});
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
    { now: () => clock, ttlMs: 30000, ...manualTimers() },
  );

  assert.equal(ready(), false);
  await drain();
  assert.equal(ready(), true);
  clock += 30000;
  assert.equal(ready(), true, "refresh in flight keeps the fresh result");
  await drain();
  assert.equal(calls, 2);
  assert.equal(ready.status().checking, true);
  resolveNext({});
  await drain();
  assert.equal(ready(), true);
  assert.equal(ready.status().checking, false);
});

test("a failed refresh fails closed immediately with a fixed error code", async () => {
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
    { now: () => clock, ttlMs: 30000, ...manualTimers() },
  );

  ready();
  await drain();
  assert.equal(ready(), true);
  clock += 30000;
  ready();
  await drain();
  rejectNext(new CodeBridgeError("GITHUB_RATE_LIMIT"));
  await drain();
  assert.equal(ready(), false);
  assert.deepEqual(ready.status(), {
    state: "failed",
    checking: false,
    lastResultAgeSeconds: 0,
    error: "GITHUB_RATE_LIMIT",
  });
});

test("a success older than ttl plus grace fails closed while re-probing", async () => {
  let clock = 1000;
  let calls = 0;
  const ready = createGitHubReadiness(
    () => {
      calls++;
      if (calls === 1) return Promise.resolve({});
      return new Promise(() => {});
    },
    { now: () => clock, ttlMs: 30000, graceMs: 10000, ...manualTimers() },
  );

  ready();
  await drain();
  assert.equal(ready(), true);
  clock += 30000;
  assert.equal(ready(), true, "inside grace");
  clock += 10000;
  assert.equal(ready(), false, "past ttl + grace");
  assert.equal(ready.status().state, "stale");
  await drain();
  assert.equal(calls, 2, "still one coalesced refresh");
});

test("a hung probe times out instead of freezing readiness forever", async () => {
  let clock = 1000;
  let calls = 0;
  const timers = manualTimers();
  const ready = createGitHubReadiness(
    () => {
      calls++;
      return calls === 1 ? new Promise(() => {}) : Promise.resolve({});
    },
    { now: () => clock, ttlMs: 30000, timeoutMs: 15000, ...timers },
  );

  assert.equal(ready(), false);
  await drain();
  timers.fireAll();
  await drain();
  assert.deepEqual(ready.status(), {
    state: "failed",
    checking: false,
    lastResultAgeSeconds: 0,
    error: "GITHUB_TIMEOUT",
  });
  clock += 30000;
  ready();
  await drain();
  assert.equal(ready(), true, "a later probe can recover");
  assert.equal(calls, 2);
});

test("error codes are fixed categories and never echo messages", () => {
  assert.equal(
    readinessErrorCode(new CodeBridgeError("GITHUB_AUTHORIZATION_FAILED")),
    "GITHUB_AUTHORIZATION_FAILED",
  );
  const timeout = new Error("x");
  timeout.name = "TimeoutError";
  assert.equal(readinessErrorCode(timeout), "GITHUB_TIMEOUT");
  assert.equal(
    readinessErrorCode(new TypeError("fetch failed ghp_secret123")),
    "GITHUB_UNREACHABLE",
  );
  assert.equal(
    readinessErrorCode(new Error("upstream said: leaked-private-value-7f3a")),
    "GITHUB_PROBE_FAILED",
  );
  assert.equal(
    readinessErrorCode(new CodeBridgeError("lowercase secret ghp_x")),
    "GITHUB_PROBE_FAILED",
  );
});

test("disabled GitHub integration has no network probing", () => {
  const ready = createGitHubReadiness(null);
  assert.equal(ready(), false);
  assert.deepEqual(ready.status(), { state: "disabled" });
});
