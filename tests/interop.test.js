import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { startGateway } from "../src/gateway.js";
import { startAgent } from "../src/agent.js";
import { definitions } from "../src/tools.js";

// Vendor-neutral MCP interoperability contract. ChatGPT, Claude.ai, Claude
// Desktop, Claude Code and future clients all speak standard MCP over
// Streamable HTTP to the same gateway. These tests drive the real gateway and
// device agent with the official MCP SDK client and assert protocol behavior;
// nothing here imitates a specific vendor's private implementation.
const digest = (s) => createHash("sha256").update(s).digest("hex");
const fullToken = "f".repeat(48),
  readToken = "r".repeat(48),
  agentToken = "a".repeat(48);
const clientNames = ["claude-code", "claude-ai", "openai-mcp", "future-client"];
const accept = "application/json, text/event-stream";

async function bridge(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-interop-"));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "hello.txt"), "hello");
  fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(262145));
  fs.writeFileSync(
    path.join(root, "many.txt"),
    Array.from({ length: 150 }, (_, i) => `needle ${i}`).join("\n"),
  );
  const devices = { d1: ["p1"], offline: ["p1"] };
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    deviceTimeoutMs: 400,
    users: extra.users ?? [
      {
        id: "full",
        tenant: "t1",
        tokenHash: digest(fullToken),
        devices,
        permissions: ["read", "write", "execute"],
      },
      {
        id: "reader",
        tenant: "t1",
        tokenHash: digest(readToken),
        devices,
        permissions: ["read"],
      },
    ],
    agents: [
      { id: "d1", tenant: "t1", tokenHash: digest(agentToken) },
      { id: "offline", tenant: "t1", tokenHash: digest("o".repeat(48)) },
    ],
    ...(extra.oauth ? { oauth: extra.oauth } : {}),
  });
  const agent = await startAgent({
    gateway: gw.url,
    token: agentToken,
    id: "d1",
    tenant: "t1",
    stateDir: path.join(dir, "state"),
    pollMs: 10,
    projects: [
      {
        id: "p1",
        root,
        writable: true,
        gates: {
          unit: {
            command: process.execPath,
            args: ["-e", 'console.log("PASS")'],
            timeoutMs: 2000,
          },
        },
      },
    ],
    license: { mode: "free" },
  });
  const connectionState = path.join(dir, "state", "connection.json");
  for (let i = 0; i < 100 && !fs.existsSync(connectionState); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    fs.existsSync(connectionState),
    "agent must complete authenticated gateway health probe before client contract tests",
  );

  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    await agent.close();
    await gw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function connect(token, name = "contract-test") {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", gw.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  }
  return { gw, root, connect };
}
const body = (r) => JSON.parse(r.content[0].text);
const scoped = { device: "d1", project: "p1" };
async function expectRejected(promise, code) {
  let result;
  try {
    result = await promise;
  } catch (e) {
    // Protocol-level rejection (invalid params) is equally acceptable.
    assert.equal(typeof e.code, "number");
    return;
  }
  assert.equal(result.isError, true);
  if (code) assert.equal(body(result).error, code);
}

test("handshake and tools/list are identical for every client identity", async (t) => {
  const { connect } = await bridge(t);
  const lists = [];
  for (const name of clientNames) {
    const client = await connect(fullToken, name);
    const server = client.getServerVersion();
    assert.equal(server.name, "kmj-codebridge");
    assert.equal(server.title, "KMJ CodeBridge");
    assert.equal(server.version, "0.1.5");
    assert.equal(server.websiteUrl, "https://kmjtechno.com");
    assert.ok(client.getServerCapabilities()?.tools);
    lists.push(JSON.stringify((await client.listTools()).tools));
  }
  assert.equal(new Set(lists).size, 1);
});

test("tools/list exposes one canonical contract with schemas and annotations", async (t) => {
  const { connect } = await bridge(t);
  const { tools } = await (await connect(fullToken)).listTools();
  assert.deepEqual(
    tools.map((x) => x.name).sort(),
    Object.keys(definitions).sort(),
  );
  for (const tool of tools) {
    const d = definitions[tool.name];
    assert.equal(tool.title, d.title);
    assert.equal(tool.description, d.description);
    assert.equal(tool.inputSchema.type, "object");
    for (const key of Object.keys(d.input))
      assert.ok(tool.inputSchema.properties?.[key], `${tool.name}.${key}`);
    const a = tool.annotations;
    assert.equal(a.title, d.title);
    assert.equal(a.readOnlyHint, d.access === "read");
    assert.equal(a.destructiveHint, d.access !== "read");
    assert.equal(a.idempotentHint, d.access === "read");
    assert.equal(a.openWorldHint, tool.name === "run_quality_gate");
    // Static-bearer mode adds no client-specific metadata.
    assert.equal(tool._meta?.securitySchemes, undefined);
  }
  const write = tools.find((x) => x.name === "write_file");
  assert.deepEqual(
    [...write.inputSchema.required].sort(),
    ["content", "device", "expectedHash", "path", "project"].sort(),
  );
});

test("tool invocation returns structured results through the device agent", async (t) => {
  const { connect } = await bridge(t);
  const client = await connect(fullToken, "claude-code");
  const info = body(
    await client.callTool({ name: "inspect_project", arguments: scoped }),
  );
  assert.equal(info.device, "d1");
  assert.deepEqual(info.gates, ["unit"]);
  const file = body(
    await client.callTool({
      name: "read_file",
      arguments: { ...scoped, path: "hello.txt" },
    }),
  );
  assert.equal(file.content, "hello");
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
});

test("MCP discovery is public while tool execution stays authenticated", async (t) => {
  const { gw } = await bridge(t);
  const init = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-ai", version: "1" },
    },
  });
  for (const authorization of [
    undefined,
    "Bearer " + "z".repeat(48),
    "Basic " + Buffer.from("a:b").toString("base64"),
    "Bearer " + agentToken,
  ]) {
    const r = await fetch(gw.url + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept,
        ...(authorization ? { authorization } : {}),
      },
      body: init,
    });
    assert.equal(r.status, 200);
  }
  const denied = await fetch(gw.url + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_devices", arguments: {} },
    }),
  });
  assert.equal(denied.status, 401);

  const origin = await fetch(gw.url + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept,
      authorization: "Bearer " + fullToken,
      origin: "https://evil.example",
    },
    body: init,
  });
  assert.equal(origin.status, 403);
});

test("invalid arguments are rejected and never touch files", async (t) => {
  const { connect, root } = await bridge(t);
  const client = await connect(fullToken);
  await expectRejected(
    client.callTool({ name: "read_file", arguments: { ...scoped } }),
  );
  await expectRejected(
    client.callTool({
      name: "read_file",
      arguments: { ...scoped, path: "../outside.txt" },
    }),
  );
  await expectRejected(
    client.callTool({
      name: "write_file",
      arguments: {
        ...scoped,
        path: "hello.txt",
        content: "x",
        expectedHash: "not-a-hash",
      },
    }),
  );
  assert.equal(fs.readFileSync(path.join(root, "hello.txt"), "utf8"), "hello");
});

test("insufficient permission is denied and the file is unchanged", async (t) => {
  const { connect, root } = await bridge(t);
  const reader = await connect(readToken, "claude-ai");
  const before = body(
    await reader.callTool({
      name: "read_file",
      arguments: { ...scoped, path: "hello.txt" },
    }),
  );
  await expectRejected(
    reader.callTool({
      name: "write_file",
      arguments: {
        ...scoped,
        path: "hello.txt",
        content: "changed",
        expectedHash: before.sha256,
      },
    }),
    "ACCESS_DENIED",
  );
  await expectRejected(
    reader.callTool({
      name: "run_quality_gate",
      arguments: { ...scoped, gate: "unit", requestKey: "k" },
    }),
    "ACCESS_DENIED",
  );
  assert.equal(fs.readFileSync(path.join(root, "hello.txt"), "utf8"), "hello");
});

test("stale write preconditions conflict instead of overwriting", async (t) => {
  const { connect, root } = await bridge(t);
  const client = await connect(fullToken);
  await expectRejected(
    client.callTool({
      name: "write_file",
      arguments: {
        ...scoped,
        path: "hello.txt",
        content: "overwrite",
        expectedHash: "0".repeat(64),
      },
    }),
    "CONTENT_CONFLICT",
  );
  assert.equal(fs.readFileSync(path.join(root, "hello.txt"), "utf8"), "hello");
});

test("an offline device times out with safe retry guidance", async (t) => {
  const { connect } = await bridge(t);
  const client = await connect(fullToken);
  const started = Date.now();
  const result = await client.callTool({
    name: "inspect_project",
    arguments: { device: "offline", project: "p1" },
  });
  assert.equal(result.isError, true);
  const error = body(result);
  assert.equal(error.error, "DEVICE_TIMEOUT");
  assert.match(error.retry, /Inspect state before repeating writes/);
  assert.ok(Date.now() - started < 5000);
  const devices = body(
    await client.callTool({ name: "list_devices", arguments: {} }),
  ).devices;
  assert.equal(devices.find((d) => d.id === "offline").online, false);
});

test("retries with the same requestKey reuse one durable job", async (t) => {
  const { connect } = await bridge(t);
  const client = await connect(fullToken, "claude-desktop");
  const args = { ...scoped, gate: "unit", requestKey: "retry-contract" };
  const first = body(
    await client.callTool({ name: "run_quality_gate", arguments: args }),
  );
  const second = body(
    await client.callTool({ name: "run_quality_gate", arguments: args }),
  );
  assert.equal(second.id, first.id);
});

test("responses are bounded for large files and broad searches", async (t) => {
  const { connect } = await bridge(t);
  const client = await connect(fullToken);
  await expectRejected(
    client.callTool({
      name: "read_file",
      arguments: { ...scoped, path: "big.txt" },
    }),
    "FILE_TOO_LARGE",
  );
  const search = body(
    await client.callTool({
      name: "search_code",
      arguments: { ...scoped, query: "needle" },
    }),
  );
  assert.ok(search.matches.length <= 100);
  assert.equal(search.truncated, true);
});

test("OAuth discovery and scopes work for standards-based remote clients", async (t) => {
  const pair = await generateKeyPair("EdDSA");
  const oauth = {
    issuer: "https://identity.example",
    resource: "https://bridge.example/mcp",
    jwks: { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1" }] },
  };
  const devices = { d1: ["p1"], offline: ["p1"] };
  const { gw, connect } = await bridge(t, {
    oauth,
    users: [
      {
        id: "full",
        tenant: "t1",
        subject: "user-1",
        devices,
        permissions: ["read", "write", "execute"],
      },
    ],
  });
  const jwt = (scope, audience = oauth.resource) =>
    new SignJWT({ scope })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setSubject("user-1")
      .setIssuer(oauth.issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey);

  const challenge = await fetch(gw.url + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body: "{}",
  });
  assert.equal(challenge.status, 401);
  const header = challenge.headers.get("www-authenticate");
  assert.match(
    header,
    /^Bearer resource_metadata="https:\/\/bridge\.example\//,
  );
  assert.match(
    header,
    /scope="codebridge:read codebridge:write codebridge:execute"/,
  );
  for (const suffix of ["", "/mcp"]) {
    const r = await fetch(
      gw.url + "/.well-known/oauth-protected-resource" + suffix,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      resource: oauth.resource,
      authorization_servers: [oauth.issuer],
      scopes_supported: [
        "codebridge:read",
        "codebridge:write",
        "codebridge:execute",
      ],
    });
  }
  const wrongAudience = await fetch(gw.url + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept,
      authorization:
        "Bearer " + (await jwt("codebridge:read", "https://other.example/mcp")),
    },
    body: "{}",
  });
  assert.equal(wrongAudience.status, 401);

  const client = await connect(await jwt("codebridge:read"), "claude-ai");
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((x) => x.name).sort(),
    Object.keys(definitions).sort(),
  );
  const denied = await client.callTool({
    name: "write_file",
    arguments: {
      ...scoped,
      path: "hello.txt",
      content: "x",
      expectedHash: null,
    },
  });
  assert.equal(denied.isError, true);
  assert.equal(body(denied).error, "ACCESS_DENIED");
  assert.match(denied._meta["mcp/www_authenticate"][0], /insufficient_scope/);
  assert.equal(
    body(await client.callTool({ name: "inspect_project", arguments: scoped }))
      .device,
    "d1",
  );
});
