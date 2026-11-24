import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { startGateway } from "../src/gateway.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const reader = "r".repeat(48);
const agentToken = "a".repeat(48);
const userToken = "u".repeat(48);
const request = {
  tenant: "tenant-a",
  grants: [{ device: "desk1", project: "project1" }],
};

async function setup(t, enabled = true) {
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === "https://platform.example/introspect")
      return Response.json({
        active: true,
        device_id: "desk1",
        tenant_id: "tenant-a",
        projects: ["project1"],
        permissions: ["read"],
      });
    return realFetch(url, options);
  });
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    users: [
      {
        id: "user1",
        tenant: "tenant-a",
        tokenHash: digest(userToken),
        devices: { desk1: ["project1"] },
        permissions: ["read"],
      },
    ],
    agentIntrospection: {
      endpoint: "https://platform.example/introspect",
    },
    ...(enabled ? { dashboardPresence: { tokenHash: digest(reader) } } : {}),
  });
  t.after(() => gateway.close());
  const post = (path, token, data, extra = {}) =>
    fetch(gateway.url + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        ...extra,
      },
      body: JSON.stringify(data),
    });
  return {
    post,
    presence: (data = request, token = reader, extra = {}) =>
      post("/internal/dashboard/presence", token, data, extra),
  };
}

test("private presence requires opt-in and an independent reader", async (t) => {
  const { presence } = await setup(t);
  assert.equal((await presence(request, userToken)).status, 401);
  assert.equal((await presence(request, agentToken)).status, 401);
  assert.equal(
    (await presence(request, reader, { "x-forwarded-for": "127.0.0.1" }))
      .status,
    404,
  );
  assert.equal(
    (await presence(request, reader, { origin: "https://kmjtechno.com" }))
      .status,
    404,
  );
});

test("private presence is unavailable by default", async (t) => {
  const { presence } = await setup(t, false);
  assert.equal((await presence()).status, 404);
});

test("only exact tenant and active introspected project can report READY", async (t) => {
  const { post, presence } = await setup(t);
  const unknown = {
    device: "desk1",
    project: "project1",
    status: "UNKNOWN",
    lastSeenAt: null,
  };
  assert.deepEqual((await (await presence()).json()).entries, [unknown]);
  assert.equal((await post("/agent/unknown", agentToken, {})).status, 404);
  assert.deepEqual((await (await presence()).json()).entries, [unknown]);
  assert.equal((await post("/agent/health", agentToken, {})).status, 200);
  const snapshot = await (await presence()).json();
  assert.equal(snapshot.tenant, "tenant-a");
  assert.equal(snapshot.entries[0].status, "READY");
  assert.ok(Number.isFinite(Date.parse(snapshot.entries[0].lastSeenAt)));
  assert.deepEqual(
    (await (await presence({ ...request, tenant: "tenant-b" })).json()).entries,
    [unknown],
  );
  const foreign = await (
    await presence({
      ...request,
      grants: [{ device: "desk1", project: "other" }],
    })
  ).json();
  assert.deepEqual(foreign.entries, [{ ...unknown, project: "other" }]);
  assert.equal(
    (
      await presence({
        ...request,
        grants: [...request.grants, ...request.grants],
      })
    ).status,
    400,
  );
  assert.equal((await presence({ ...request, command: "restart" })).status, 400);
});
