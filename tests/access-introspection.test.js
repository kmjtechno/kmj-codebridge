import test from "node:test";
import assert from "node:assert/strict";
import { createUserIntrospector } from "../src/user-access.js";

async function resolveMembership(t, devices) {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      active: true,
      user_id: "user-7",
      memberships: [{ tenant_id: "tenant-a", permissions: ["read"], devices }],
    }),
  );
  const resolve = createUserIntrospector({
    endpoint: "https://platform.example/introspect",
    cacheSeconds: 30,
  });
  try {
    return await resolve("Bearer " + "x".repeat(48), "user-7");
  } finally {
    t.mock.restoreAll();
  }
}

test("introspection preserves scoped device/project grants", async (t) => {
  const user = await resolveMembership(t, { device1: ["project1"] });
  assert.deepEqual(user.memberships[0].devices, {
    device1: ["project1"],
  });
});

test("introspection rejects malformed device project grants", async (t) => {
  for (const devices of [
    [],
    { "../device": ["project1"] },
    { device1: ["../project"] },
    { device1: "project1" },
    { device1: Array(101).fill("project1") },
  ]) {
    assert.equal(await resolveMembership(t, devices), null);
  }
});

test("introspection retains an explicit empty device grant map", async (t) => {
  const user = await resolveMembership(t, {});
  assert.deepEqual(user.memberships[0].devices, {});
});

test("introspection leaves absent device grants absent", async (t) => {
  const user = await resolveMembership(t, undefined);
  assert.equal(Object.hasOwn(user.memberships[0], "devices"), false);
});

async function gatewayGrants(
  t,
  devices,
  dynamic = false,
  agentProjects = ["project1"],
  scopes = ["read"],
  expectedHeartbeatStatus = 200,
) {
  const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
  const { createHash } = await import("node:crypto");
  const { startGateway } = await import("../src/gateway.js");
  const pair = await generateKeyPair("EdDSA");
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "grants" };
  const agentCredential = "a".repeat(48);
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === "https://platform.example/user") {
      return Response.json({
        active: true,
        user_id: "user-7",
        memberships: [{ tenant_id: "tenant-a", permissions: scopes, devices }],
      });
    }
    if (String(url) === "https://platform.example/agent") {
      return Response.json({
        active: true,
        device_id: "device1",
        tenant_id: "tenant-a",
        projects: agentProjects,
        permissions: ["read", "write", "execute"],
      });
    }
    return originalFetch(url, options);
  });
  const gateway = await startGateway({
    port: 0,
    oauth: {
      issuer: "https://platform.example",
      resource: "https://bridge.example/mcp",
      jwks: { keys: [jwk] },
    },
    userIntrospection: {
      endpoint: "https://platform.example/user",
      cacheSeconds: 30,
    },
    agentIntrospection: {
      endpoint: "https://platform.example/agent",
      cacheSeconds: 30,
    },
    agents: dynamic
      ? []
      : [
          {
            id: "device1",
            tenant: "tenant-a",
            tokenHash: createHash("sha256")
              .update(agentCredential)
              .digest("hex"),
          },
        ],
  });
  const jwt = await new SignJWT({
    scope: scopes.map((scope) => `codebridge:${scope}`).join(" "),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "grants" })
    .setSubject("user-7")
    .setIssuer("https://platform.example")
    .setAudience("https://bridge.example/mcp")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  t.after(() => gateway.close());
  const client = {
    async callTool(params) {
      const response = await fetch(gateway.url + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + jwt,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params,
        }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.ok(payload.result, JSON.stringify(payload));
      return payload.result;
    },
  };
  const heartbeat = await fetch(gateway.url + "/agent/health", {
    method: "POST",
    headers: {
      authorization: "Bearer " + agentCredential,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(heartbeat.status, expectedHeartbeatStatus);
  if (heartbeat.status !== 200)
    return { client, heartbeatStatus: heartbeat.status, devices: null };
  const result = await client.callTool({
    name: "list_devices",
    arguments: {},
  });
  return { client, devices: JSON.parse(result.content[0].text).devices };
}

test("OAuth introspection grants a listed static agent project", async (t) => {
  const result = await gatewayGrants(t, { device1: ["project1"] });
  assert.deepEqual(result.devices, [
    { id: "device1", projects: ["project1"], online: true },
  ]);
});

test("explicit OAuth grants deny an unlisted dynamic agent", async (t) => {
  const result = await gatewayGrants(t, {}, true);
  assert.deepEqual(result.devices, []);
  const denied = await result.client.callTool({
    name: "read_file",
    arguments: { device: "device1", project: "project1", path: "hello.txt" },
  });
  assert.equal(JSON.parse(denied.content[0].text).error, "ACCESS_DENIED");
});

test("structured agent grants enforce per-project permissions", async (t) => {
  const result = await gatewayGrants(
    t,
    { device1: ["project1"] },
    true,
    [
      {
        id: "project1",
        permissions: ["read"],
        gate_preset: "node-safe",
        status: "active",
      },
    ],
    ["read", "write", "execute"],
  );
  assert.deepEqual(result.devices, [
    { id: "device1", projects: ["project1"], online: true },
  ]);
  const denied = await result.client.callTool({
    name: "write_file",
    arguments: {
      device: "device1",
      project: "project1",
      path: "hello.txt",
      content: "blocked",
      expectedHash: "0".repeat(64),
    },
  });
  assert.match(denied.content[0].text, /ACCESS_DENIED/);
});

test("paused structured agent grants are not exposed or authorized", async (t) => {
  const result = await gatewayGrants(t, { device1: ["project1"] }, true, [
    { id: "project1", status: "paused" },
  ]);
  assert.deepEqual(result.devices, []);
  const denied = await result.client.callTool({
    name: "read_file",
    arguments: {
      device: "device1",
      project: "project1",
      path: "hello.txt",
    },
  });
  assert.equal(JSON.parse(denied.content[0].text).error, "ACCESS_DENIED");
});

test("structured agent grants reject duplicate project ids", async (t) => {
  const result = await gatewayGrants(
    t,
    { device1: ["project1"] },
    true,
    [{ id: "project1" }, { id: "project1" }],
    ["read"],
    401,
  );
  assert.equal(result.heartbeatStatus, 401);
});

test("connection overview separates registered agent and missing gateway registration", async (t) => {
  const result = await gatewayGrants(
    t,
    { device1: ["project1"], main_platform_vm: ["kmj-main-platform"] },
    true,
  );
  assert.deepEqual(result.devices, [
    { id: "device1", projects: ["project1"], online: true },
    {
      id: "main_platform_vm",
      projects: ["kmj-main-platform"],
      online: false,
    },
  ]);
  const response = await result.client.callTool({
    name: "connection_overview",
    arguments: {},
  });
  const overview = JSON.parse(response.content[0].text);
  assert.equal(overview.overallStatus, "NEEDS_ATTENTION");
  assert.equal(overview.readyCount, 1);
  assert.equal(overview.attentionCount, 1);
  assert.deepEqual(overview.devices, [
    {
      device: "device1",
      project: "project1",
      status: "READY",
      nextAction: "NONE",
      connectionState: "online",
    },
    {
      device: "main_platform_vm",
      project: "kmj-main-platform",
      status: "GATEWAY_REGISTRATION_MISSING",
      nextAction: "RUN_VM_CONNECTION_DOCTOR",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(overview), /tenant-a|aaaaaa/);
});

test("connection overview does not disclose a device without account grant", async (t) => {
  const result = await gatewayGrants(t, { device1: ["project1"] }, true);
  const response = await result.client.callTool({
    name: "connection_overview",
    arguments: { expectedDevice: "not_mine" },
  });
  const overview = JSON.parse(response.content[0].text);
  assert.equal(overview.overallStatus, "ACCOUNT_GRANT_MISSING");
  assert.equal(overview.expectedDevice, "not_mine");
  assert.deepEqual(overview.devices, []);
  assert.equal(
    overview.nextAction,
    "CHECK_MAIN_PLATFORM_ACCOUNT_AND_DEVICE_PAIRING",
  );
});

test("connection overview detects project mismatch without permitting access", async (t) => {
  const result = await gatewayGrants(t, { device1: ["project1"] }, true, [
    "different_project",
  ]);
  const response = await result.client.callTool({
    name: "connection_overview",
    arguments: {},
  });
  const overview = JSON.parse(response.content[0].text);
  assert.equal(overview.devices[0].status, "PROJECT_SCOPE_MISMATCH");
  assert.equal(
    overview.devices[0].nextAction,
    "VERIFY_ENROLLED_PROJECT_AND_GRANT",
  );
  const denied = await result.client.callTool({
    name: "read_file",
    arguments: { device: "device1", project: "project1", path: "README.md" },
  });
  assert.equal(JSON.parse(denied.content[0].text).error, "ACCESS_DENIED");
});
