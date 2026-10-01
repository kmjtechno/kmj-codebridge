import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startGateway } from "../src/gateway.js";
import { startAgent } from "../src/agent.js";
const digest = (s) => createHash("sha256").update(s).digest("hex");
const userToken = "u".repeat(48),
  agentToken = "a".repeat(48),
  otherToken = "b".repeat(48);
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-e2e-"));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "hello.txt"), "hello");
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    users: [
      {
        id: "u1",
        tenant: "t1",
        tokenHash: digest(userToken),
        devices: { d1: ["p1"] },
        permissions: ["read", "write", "execute"],
      },
      {
        id: "u2",
        tenant: "t2",
        tokenHash: digest(otherToken),
        devices: { d1: ["p1"] },
        permissions: ["read"],
      },
    ],
    agents: [{ id: "d1", tenant: "t1", tokenHash: digest(agentToken) }],
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
  const client = new Client({ name: "test", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", gw.url), {
    requestInit: { headers: { Authorization: `Bearer ${userToken}` } },
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await agent.close();
    await gw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { client, gw, root, dir };
}
const content = (r) => JSON.parse(r.content[0].text);
test("real MCP SDK discovers tools and reaches outbound agent", async (t) => {
  const { client } = await setup(t);
  const list = await client.listTools();
  assert.ok(list.tools.some((x) => x.name === "read_file"));
  const r = await client.callTool({
    name: "read_file",
    arguments: { device: "d1", project: "p1", path: "hello.txt" },
  });
  assert.equal(content(r).content, "hello");
});
test("agent persists authenticated gateway connectivity heartbeat", async (t) => {
  const { client, dir } = await setup(t);
  await client.listTools();
  const state = path.join(dir, "state", "connection.json");
  for (let i = 0; i < 20 && !fs.existsSync(state); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(state));
  const saved = JSON.parse(fs.readFileSync(state, "utf8"));
  assert.ok(Number.isFinite(Date.parse(saved.connectedAt)));
  if (process.platform !== "win32")
    assert.equal(fs.statSync(state).mode & 0o077, 0);
});

test("directory listing and precise edit accelerate scoped coding", async (t) => {
  const { client, root } = await setup(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), 'const mode = "slow";\n');
  fs.writeFileSync(path.join(root, ".env"), "SECRET=hidden\n");

  const listed = content(
    await client.callTool({
      name: "list_directory",
      arguments: { device: "d1", project: "p1", path: "" },
    }),
  );
  assert.ok(listed.entries.some((entry) => entry.name === "src"));
  assert.ok(!listed.entries.some((entry) => entry.name === ".env"));

  const args = { device: "d1", project: "p1", path: "src/app.js" };
  const before = content(
    await client.callTool({ name: "read_file", arguments: args }),
  );
  const edited = await client.callTool({
    name: "edit_file",
    arguments: {
      ...args,
      oldText: "slow",
      newText: "fast",
      expectedHash: before.sha256,
    },
  });
  assert.equal(edited.isError, undefined);
  assert.equal(
    content(await client.callTool({ name: "read_file", arguments: args }))
      .content,
    'const mode = "fast";\n',
  );
});

test("precise edit rejects stale hashes and ambiguous replacements", async (t) => {
  const { client, root } = await setup(t);
  fs.writeFileSync(path.join(root, "repeat.txt"), "same same\n");
  const args = { device: "d1", project: "p1", path: "repeat.txt" };
  const before = content(
    await client.callTool({ name: "read_file", arguments: args }),
  );
  const ambiguous = await client.callTool({
    name: "edit_file",
    arguments: {
      ...args,
      oldText: "same",
      newText: "new",
      expectedHash: before.sha256,
    },
  });
  assert.equal(content(ambiguous).error, "EDIT_TEXT_AMBIGUOUS");

  fs.writeFileSync(path.join(root, "repeat.txt"), "changed\n");
  const stale = await client.callTool({
    name: "edit_file",
    arguments: {
      ...args,
      oldText: "changed",
      newText: "new",
      expectedHash: before.sha256,
    },
  });
  assert.equal(content(stale).error, "CONTENT_CONFLICT");
});

test("partial reads and git diff keep coding context bounded", async (t) => {
  const { client, root } = await setup(t);
  fs.writeFileSync(
    path.join(root, "lines.txt"),
    Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n"),
  );
  const range = content(
    await client.callTool({
      name: "read_file_range",
      arguments: {
        device: "d1",
        project: "p1",
        path: "lines.txt",
        startLine: 11,
        maxLines: 5,
      },
    }),
  );
  assert.equal(range.content, "line-11\nline-12\nline-13\nline-14\nline-15");
  assert.equal(range.startLine, 11);
  assert.equal(range.endLine, 15);
  assert.equal(range.hasMore, true);

  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "hello.txt"], { cwd: root, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "init",
    ],
    { cwd: root, stdio: "pipe" },
  );
  fs.writeFileSync(path.join(root, "hello.txt"), "hello changed\n");
  const diff = content(
    await client.callTool({
      name: "git_diff",
      arguments: { device: "d1", project: "p1" },
    }),
  );
  assert.match(diff.diff, /hello changed/);
  assert.equal(typeof diff.truncated, "boolean");
});

test("real read-preview-write-test workflow verifies results", async (t) => {
  const { client } = await setup(t);
  const args = { device: "d1", project: "p1", path: "hello.txt" };
  const before = content(
    await client.callTool({ name: "read_file", arguments: args }),
  );
  const changed = await client.callTool({
    name: "write_file",
    arguments: { ...args, content: "changed", expectedHash: before.sha256 },
  });
  assert.equal(changed.isError, undefined);
  assert.equal(
    content(await client.callTool({ name: "read_file", arguments: args }))
      .content,
    "changed",
  );
  const job = content(
    await client.callTool({
      name: "run_quality_gate",
      arguments: {
        device: "d1",
        project: "p1",
        gate: "unit",
        requestKey: "integration",
      },
    }),
  );
  let done;
  for (let i = 0; i < 30; i++) {
    done = content(
      await client.callTool({
        name: "get_job_status",
        arguments: { device: "d1", project: "p1", job: job.id },
      }),
    );
    if (done.state !== "running") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(done.state, "succeeded");
  assert.equal(done.exitCode, 0);
});
test("unauthenticated requests fail before MCP handling", async (t) => {
  const { gw } = await setup(t);
  const r = await fetch(gw.url + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 401);
});
test("cross-tenant device listing is empty and calls are denied", async (t) => {
  const { gw } = await setup(t);
  const client = new Client({ name: "other", version: "1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", gw.url), {
      requestInit: { headers: { Authorization: `Bearer ${otherToken}` } },
    }),
  );
  t.after(() => client.close());
  assert.deepEqual(
    content(await client.callTool({ name: "list_devices", arguments: {} }))
      .devices,
    [],
  );
  const r = await client.callTool({
    name: "read_file",
    arguments: { device: "d1", project: "p1", path: "hello.txt" },
  });
  assert.equal(r.isError, true);
  assert.equal(content(r).error, "ACCESS_DENIED");
});
test("unauthorized projects and paths return structured errors", async (t) => {
  const { client } = await setup(t);
  for (const [project, file, error] of [
    ["other", "hello.txt", "ACCESS_DENIED"],
    ["p1", "../hello.txt", "INVALID_PATH"],
    ["p1", ".env", "PATH_DENIED"],
  ]) {
    const r = await client.callTool({
      name: "read_file",
      arguments: { device: "d1", project, path: file },
    });
    assert.equal(content(r).error, error);
  }
});
test("agent route rejects user credential and malicious Origin", async (t) => {
  const { gw } = await setup(t);
  assert.equal(
    (
      await fetch(gw.url + "/agent/poll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${userToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(gw.url + "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${userToken}`,
          origin: "https://evil.test",
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
});
test("redacted files cannot be overwritten with redacted placeholders", async (t) => {
  const { client, root } = await setup(t);
  fs.writeFileSync(
    path.join(root, "settings.txt"),
    "api_key=never-share-this-value",
  );
  const args = { device: "d1", project: "p1", path: "settings.txt" };
  const r = content(
    await client.callTool({ name: "read_file", arguments: args }),
  );
  assert.ok(!r.content.includes("never-share"));
  assert.equal(r.redacted, true);
  const write = await client.callTool({
    name: "write_file",
    arguments: { ...args, content: r.content, expectedHash: r.sha256 },
  });
  assert.equal(content(write).error, "SENSITIVE_CONTENT_PROTECTED");
  assert.match(
    fs.readFileSync(path.join(root, "settings.txt"), "utf8"),
    /never-share/,
  );
});
test("Git status cannot discover a repository above authorized project root", async (t) => {
  const { client, root } = await setup(t);
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init"], { cwd: path.dirname(root), stdio: "pipe" });
  fs.writeFileSync(
    path.join(path.dirname(root), "outside-customer-file.txt"),
    "private",
  );
  const result = await client.callTool({
    name: "git_status",
    arguments: { device: "d1", project: "p1" },
  });
  assert.equal(content(result).error, "GIT_ROOT_OUTSIDE_PROJECT");
  assert.ok(!JSON.stringify(result).includes("outside-customer-file"));
});
test("signed entitlement file must remain outside project roots", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-license-boundary-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const tokenFile = path.join(root, "license.jws");
  fs.writeFileSync(tokenFile, "not-a-real-license");
  let service;
  try {
    await assert.rejects(async () => {
      service = await startAgent({
        gateway: "http://127.0.0.1:1",
        token: "a".repeat(48),
        id: "d1",
        tenant: "t1",
        stateDir: path.join(dir, "state"),
        projects: [{ id: "p1", root }],
        license: { mode: "signed", tokenFile, keys: {} },
      });
    }, /LICENSE_INSIDE_PROJECT/);
  } finally {
    if (service) await service.close();
  }
});

test("dynamically enrolled agent introspects once then serves MCP tools from cache", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dynamic-agent-"));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "hello.txt"), "dynamic");
  const dynamicToken = "d".repeat(48);
  const seedToken = "s".repeat(48);
  const originalFetch = globalThis.fetch;
  let introspections = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (
      String(url) ===
      "https://platform.example/api/codebridge/v1/device-credentials/introspect"
    ) {
      introspections++;
      assert.equal(options.headers.authorization, `Bearer ${dynamicToken}`);
      return Response.json({
        active: true,
        device_id: "dyn1",
        tenant_id: "t1",
        projects: ["p1"],
      });
    }
    return originalFetch(url, options);
  });

  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    users: [
      {
        id: "u1",
        tenant: "t1",
        tokenHash: digest(userToken),
        devices: {},
        permissions: ["read", "write", "execute"],
      },
    ],
    agents: [{ id: "seed", tenant: "t1", tokenHash: digest(seedToken) }],
    agentIntrospection: {
      endpoint:
        "https://platform.example/api/codebridge/v1/device-credentials/introspect",
      cacheSeconds: 60,
    },
  });
  const agent = await startAgent({
    gateway: gw.url,
    token: dynamicToken,
    id: "dyn1",
    tenant: "t1",
    stateDir: path.join(dir, "state"),
    pollMs: 10,
    projects: [{ id: "p1", root, writable: true, gates: {} }],
    license: { mode: "free" },
  });
  const client = new Client({ name: "dynamic-test", version: "1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", gw.url), {
      requestInit: { headers: { Authorization: `Bearer ${userToken}` } },
    }),
  );
  t.after(async () => {
    await client.close();
    await agent.close();
    await gw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const devices = content(
    await client.callTool({ name: "list_devices", arguments: {} }),
  ).devices;
  assert.deepEqual(devices.find((device) => device.id === "dyn1")?.projects, [
    "p1",
  ]);
  const read = content(
    await client.callTool({
      name: "read_file",
      arguments: { device: "dyn1", project: "p1", path: "hello.txt" },
    }),
  );
  assert.equal(read.content, "dynamic");
  assert.equal(introspections, 1);
});
