import test from "node:test";
import assert from "node:assert/strict";
import { assertEnrollmentServerReady } from "../src/enrollment-readiness.js";

const base = "https://kmjtechno.com";

test("new Main Platform explicitly advertises compatible config without device registration", async () => {
  let calls = 0;
  const result = await assertEnrollmentServerReady(base, {
    fetch: async (url, opts) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(
          String(url),
          base + "/api/codebridge/v1/device-enrollments/readiness",
        );
        assert.equal(opts.method, "GET");
        assert.equal(opts.redirect, "error");
        assert.equal(opts.body, undefined);
        return Response.json({ pairing_config: "ready", protocol: 2 });
      }
      assert.equal(calls, 2);
      assert.equal(String(url), base + "/agent/health");
      assert.equal(opts.method, "POST");
      assert.equal(opts.redirect, "error");
      assert.equal(opts.credentials, "omit");
      assert.deepEqual(opts.headers, {
        accept: "application/json",
        "content-type": "application/json",
      });
      assert.equal(opts.body, "{}");
      // The body must never be read or logged by the no-token preflight.
      return new Response("SENSITIVE_IGNORE", { status: 401 });
    },
  });
  assert.deepEqual(result, { state: "configured_not_device_ready" });
  assert.equal(calls, 2);
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

test("configured Laravel but missing or unprotected agent route blocks pairing", async () => {
  for (const [status, code] of [
    [200, "PAIRING_AGENT_ROUTE_UNPROTECTED"],
    [302, "PAIRING_AGENT_ROUTE_UNAVAILABLE"],
    [403, "PAIRING_AGENT_ROUTE_UNAVAILABLE"],
    [404, "PAIRING_AGENT_ROUTE_UNAVAILABLE"],
    [405, "PAIRING_AGENT_ROUTE_UNAVAILABLE"],
    [503, "PAIRING_AGENT_ROUTE_UNAVAILABLE"],
  ]) {
    let calls = 0;
    await assert.rejects(
      assertEnrollmentServerReady(base, {
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? Response.json({ pairing_config: "ready", protocol: 2 })
            : new Response("SENSITIVE_IGNORE", { status });
        },
      }),
      (error) =>
        error.code === code &&
        !String(error.message).includes("SENSITIVE_IGNORE"),
    );
    assert.equal(calls, 2);
  }
});

test("gateway network failures stop pairing after valid Laravel config", async () => {
  let calls = 0;
  await assert.rejects(
    assertEnrollmentServerReady(base, {
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json({ pairing_config: "ready", protocol: 2 });
        }
        throw Error("SENSITIVE_INTERNAL_CONNECTION");
      },
    }),
    (error) =>
      error.code === "PAIRING_AGENT_ROUTE_NETWORK" &&
      !String(error.message).includes("SENSITIVE"),
  );
  assert.equal(calls, 2);
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
