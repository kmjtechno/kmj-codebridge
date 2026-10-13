import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDeployedCommit,
  verifyDeployedGateway,
  verifyDeployedGatewayOnce,
} from "../scripts/verify-render-deployment.mjs";

const SHA = "ff11bb79b2faa14dd0a4c9bda9176f968e3fba60";
const OLD_SHA = "39bc227bdfa2e48e5dff50d6b312799c98a5b0b8";
const healthy = (commit = SHA) =>
  new Response(JSON.stringify({ status: "ok", commit }), { status: 200 });

test("release verification requires the exact 40-character deployed commit", () => {
  assert.equal(assertDeployedCommit({ status: "ok", commit: SHA }, SHA), SHA);
  assert.throws(
    () => assertDeployedCommit({ status: "ok", commit: OLD_SHA }, SHA),
    /DEPLOYED_COMMIT_STALE/,
  );
  assert.throws(
    () => assertDeployedCommit({ status: "ok", commit: SHA.slice(0, 7) }, SHA),
    /DEPLOYED_COMMIT_UNVERIFIED/,
  );
  assert.throws(
    () => assertDeployedCommit({ status: "ok" }, SHA),
    /DEPLOYED_COMMIT_UNVERIFIED/,
  );
  assert.throws(
    () => assertDeployedCommit({ status: "degraded", commit: SHA }, SHA),
    /DEPLOYED_GATEWAY_UNHEALTHY/,
  );
  assert.throws(
    () => assertDeployedCommit({ status: "ok", commit: SHA }, "main"),
    /EXPECTED_COMMIT_INVALID/,
  );
});

test("release probe reads only exact Render /healthz with no token or redirect", async () => {
  const requests = [];
  const sha = await verifyDeployedGatewayOnce(SHA, async (url, options) => {
    requests.push({ url, options });
    return healthy();
  });
  assert.equal(sha, SHA);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://kmj-codebridge-gateway.onrender.com/healthz",
  );
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.headers.Authorization, undefined);
});

test("bounded Render startup/deploy-lag retries accept only the latest SHA", async () => {
  let calls = 0;
  const pauses = [];
  const actual = await verifyDeployedGateway(
    SHA,
    async () => {
      calls++;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      if (calls === 2) return healthy(OLD_SHA);
      return healthy(SHA);
    },
    async (ms) => pauses.push(ms),
  );
  assert.equal(actual, SHA);
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [3000, 6000]);
});

test("deployed SHA drift stays a failed release after six bounded attempts", async () => {
  const pauses = [];
  let calls = 0;
  await assert.rejects(
    verifyDeployedGateway(
      SHA,
      async () => {
        calls++;
        return healthy(OLD_SHA);
      },
      async (ms) => pauses.push(ms),
    ),
    /DEPLOYED_COMMIT_STALE/,
  );
  assert.equal(calls, 6);
  assert.deepEqual(pauses, [3000, 6000, 9000, 12000, 15000]);
});

test("malformed, oversized, and wrong responses fail without retry", async () => {
  for (const response of [
    new Response("not JSON", { status: 200 }),
    new Response("x".repeat(16 * 1024 + 1), { status: 200 }),
    new Response(null, { status: 200 }),
  ]) {
    let calls = 0;
    await assert.rejects(
      verifyDeployedGateway(
        SHA,
        async () => {
          calls++;
          return response;
        },
        async () => {
          throw new Error("RETRY_NOT_ALLOWED");
        },
      ),
      /DEPLOYED_HEALTH_/,
    );
    assert.equal(calls, 1);
  }
});

test("Render cold-start transport timeouts retry safely and stay bounded", async () => {
  let calls = 0;
  const pauses = [];
  const accepted = await verifyDeployedGateway(
    SHA,
    async () => {
      calls++;
      if (calls <= 2) {
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return healthy(SHA);
    },
    async (ms) => pauses.push(ms),
  );
  assert.equal(accepted, SHA);
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [3000, 6000]);

  let failingCalls = 0;
  await assert.rejects(
    verifyDeployedGateway(
      SHA,
      async () => {
        failingCalls++;
        throw new TypeError("network failed");
      },
      async () => {},
    ),
    /DEPLOYED_HEALTH_REQUEST_FAILED/,
  );
  assert.equal(failingCalls, 6);
});
