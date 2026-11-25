import test from "node:test";
import assert from "node:assert/strict";
import { createNativeModelFabricPreflight } from "../src/native-modelfabric-preflight.js";

const token = "kmjmf_" + "a".repeat(48);
const payload = {
  object: "list",
  data: [{ id: "modelfabric-auto" }],
  modelfabric: {
    scope: "private-source-coding",
    policy: "strict-free-cloud",
    status: "ROUTE_AVAILABLE",
    routes: 2,
    free_routes: 2,
  },
};

test("native discovery is fixed-origin, scoped and does not attest billing", async () => {
  let calls = 0;
  const client = createNativeModelFabricPreflight({
    token,
    authorized: () => true,
    request: async (url, options) => {
      calls++;
      assert.equal(url, "https://kmjtechno.com/api/modelfabric/v1/models");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(
        options.headers["X-ModelFabric-Policy"],
        "strict-free-cloud",
      );
      return Response.json(payload);
    },
  });
  assert.deepEqual(await client.status(), {
    available: false,
    plannedFreeRoutes: 2,
    billingVerified: false,
    generationAuthorized: false,
  });
  assert.equal(calls, 1);
});

test("missing consent or invalid token never sends a request", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return Response.json(payload);
  };
  for (const config of [
    { token },
    { token: "invalid", authorized: () => true },
    { token, authorized: () => "true" },
  ]) {
    const client = createNativeModelFabricPreflight({ ...config, request });
    assert.equal((await client.status()).plannedFreeRoutes, 0);
  }
  assert.equal(calls, 0);
});

test("wrong scope, mixed routes, legacy response and oversized bodies fail closed", async () => {
  const variants = [
    Response.json({
      ...payload,
      modelfabric: { ...payload.modelfabric, scope: "general-chat" },
    }),
    Response.json({
      ...payload,
      modelfabric: { ...payload.modelfabric, routes: 3 },
    }),
    Response.json({ ...payload, modelfabric: { routes: 2 } }),
    new Response("x".repeat(65537)),
    new Response(null, { status: 403 }),
  ];
  for (const response of variants) {
    const client = createNativeModelFabricPreflight({
      token,
      authorized: () => true,
      request: async () => response,
    });
    assert.equal((await client.status()).plannedFreeRoutes, 0);
  }
});

test("revoked consent after discovery discards the result", async () => {
  let approved = true;
  const client = createNativeModelFabricPreflight({
    token,
    authorized: () => approved,
    request: async () => {
      approved = false;
      return Response.json(payload);
    },
  });
  assert.equal((await client.status()).plannedFreeRoutes, 0);
});
