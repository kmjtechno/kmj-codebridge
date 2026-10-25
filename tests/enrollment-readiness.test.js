import test from "node:test";
import assert from "node:assert/strict";
import { assertEnrollmentServerReady } from "../src/enrollment-readiness.js";

const base = "https://kmjtechno.com";

test("new Main Platform explicitly advertises compatible config without device registration", async () => {
  let calls = 0;
  const result = await assertEnrollmentServerReady(base, {
    fetch: async (url, opts) => {
      calls += 1;
      assert.equal(
        String(url),
        base + "/api/codebridge/v1/device-enrollments/readiness",
      );
      assert.equal(opts.method, "GET");
      assert.equal(opts.redirect, "error");
      assert.equal(opts.body, undefined);
      return Response.json({ pairing_config: "ready", protocol: 2 });
    },
  });
  assert.deepEqual(result, { state: "configured_not_device_ready" });
  assert.equal(calls, 1);
});

test("legacy production returns 404 and pairing must stop before device creation", async () => {
  await assert.rejects(
    assertEnrollmentServerReady(base, {
      fetch: async () => new Response("", { status: 404 }),
    }),
    (e) => e.code === "PAIRING_SERVER_FIX_NOT_LIVE",
  );
});

test("missing origin and service gate fail closed without parsing private body", async () => {
  for (const [status, code] of [
    [503, "PAIRING_PUBLIC_ORIGIN_NOT_READY"],
    [403, "PAIRING_READINESS_UNAVAILABLE"],
    [429, "PAIRING_READINESS_UNAVAILABLE"],
  ]) {
    await assert.rejects(
      assertEnrollmentServerReady(base, {
        fetch: async () =>
          Response.json(
            { token: "SECRET_IGNORE", device_code: "SECRET_IGNORE" },
            { status },
          ),
      }),
      (e) => e.code === code && !String(e.message).includes("SECRET_IGNORE"),
    );
  }
});

test("readiness schema is strict and does not equate config with online agent", async () => {
  for (const payload of [
    {},
    null,
    [],
    { pairing_config: "ready" },
    { pairing_config: "ready", protocol: 1 },
    { pairing_config: "unavailable", protocol: 2 },
    { pairing_config: true, protocol: 2 },
  ]) {
    await assert.rejects(
      assertEnrollmentServerReady(base, {
        fetch: async () => Response.json(payload),
      }),
      (e) => e.code === "PAIRING_READINESS_SCHEMA",
    );
  }
});

test("preflight rejects untrusted origins before network contact", async () => {
  for (const url of [
    "http://kmjtechno.com",
    "https://user:pass@kmjtechno.com",
    "https://kmjtechno.com/agent",
    "https://kmjtechno.com?secret=value",
    "javascript:alert(1)",
    "/relative",
  ]) {
    await assert.rejects(
      assertEnrollmentServerReady(url, {
        fetch: async () => assert.fail("unexpected external request"),
      }),
      (e) => e.code === "ENROLLMENT_URL",
    );
  }
});

test("network errors and empty or oversized bodies return bounded safe categories", async () => {
  await assert.rejects(
    assertEnrollmentServerReady(base, {
      fetch: async () => {
        throw new Error("SECRET_INTERNAL_ROUTE");
      },
    }),
    (e) =>
      e.code === "PAIRING_READINESS_NETWORK" &&
      !String(e.message).includes("SECRET"),
  );
  await assert.rejects(
    assertEnrollmentServerReady(base, {
      fetch: async () => new Response("", { status: 200 }),
    }),
    (e) => e.code === "PAIRING_READINESS_SCHEMA",
  );
  await assert.rejects(
    assertEnrollmentServerReady(base, {
      fetch: async () =>
        new Response(JSON.stringify({ notes: "X".repeat(3000) })),
    }),
    (e) => e.code === "PAIRING_READINESS_SCHEMA",
  );
});
