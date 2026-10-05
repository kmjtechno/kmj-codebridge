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
import { VERSION } from "../src/version.js";
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
        commands: {
          inspect_node: {
            category: "inspect",
            description: "Read the configured Node runtime version.",
            command: process.execPath,
            variants: {
              version: { args: ["--version"], timeoutMs: 2000 },
            },
          },
          build_echo: {
            category: "build",
            description: "Run a bounded build fixture.",
            command: process.execPath,
            variants: {
              default: {
                args: [
                  "-e",
                  'console.log("BUILD_OK"); console.log("token=supersecret")',
                ],
                timeoutMs: 2000,
              },
            },
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
  const server = client.getServerVersion();
  assert.equal(server?.name, "kmj-codebridge");
  assert.equal(server?.title, "KMJ CodeBridge");
  assert.equal(server?.version, VERSION);
  assert.equal(server?.websiteUrl, "https://kmjtechno.com");
  const list = await client.listTools();
  assert.ok(list.tools.some((x) => x.name === "read_file"));
  const r = await client.callTool({
    name: "read_file",
    arguments: { device: "d1", project: "p1", path: "hello.txt" },
  });
  assert.equal(content(r).content, "hello");
});

test("fast context composes legacy read tools behind one MCP call", async (t) => {
  const { client } = await setup(t);
  const list = await client.listTools();
  assert.ok(list.tools.some((x) => x.name === "fast_context"));

  const result = content(
    await client.callTool({
      name: "fast_context",
      arguments: { device: "d1", project: "p1", autopilotLimit: 5 },
    }),
  );

  assert.equal(result.device, "d1");
  assert.equal(result.project, "p1");
  assert.equal(result.parts.project.ok, true);
  assert.equal(result.parts.project.value.version, VERSION);
  assert.equal(result.parts.project.value.writable, true);
  assert.deepEqual(result.parts.project.value.gates, ["unit"]);
  assert.equal(result.parts.git.ok, false);
  assert.equal(result.parts.git.error, "GIT_ROOT_OUTSIDE_PROJECT");
  assert.equal(result.parts.autopilot.ok, true);
  assert.equal(result.parts.autopilot.value.counts.queued, 0);
});

test("fast read batch isolates read-only results behind one MCP call", async (t) => {
  const { client } = await setup(t);
  const list = await client.listTools();
  assert.ok(list.tools.some((x) => x.name === "fast_read_batch"));

  const result = content(
    await client.callTool({
      name: "fast_read_batch",
      arguments: {
        device: "d1",
        project: "p1",
        calls: [
          { key: "project", tool: "inspect_project", args: {} },
          { key: "git", tool: "git_status", args: {} },
          {
            key: "autopilot",
            tool: "autopilot_status",
            args: { limit: 5 },
          },
        ],
      },
    }),
  );

  assert.equal(result.device, "d1");
  assert.equal(result.project, "p1");
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].key, "project");
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].value.version, VERSION);
  assert.equal(result.results[1].key, "git");
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].error, "GIT_ROOT_OUTSIDE_PROJECT");
  assert.equal(result.results[2].key, "autopilot");
  assert.equal(result.results[2].ok, true);
  assert.equal(result.results[2].value.counts.queued, 0);
});
test("structured project commands expose profiles without raw argv and run exact variants", async (t) => {
  const { client } = await setup(t);

  const listed = content(
    await client.callTool({
      name: "list_project_commands",
      arguments: { device: "d1", project: "p1" },
    }),
  );
  assert.deepEqual(listed.commands, [
    {
      id: "inspect_node",
      category: "inspect",
      description: "Read the configured Node runtime version.",
      variants: ["version"],
    },
    {
      id: "build_echo",
      category: "build",
      description: "Run a bounded build fixture.",
      variants: ["default"],
    },
  ]);
  assert.ok(!JSON.stringify(listed).includes(process.execPath));
  assert.ok(!JSON.stringify(listed).includes("supersecret"));

  const started = content(
    await client.callTool({
      name: "run_project_command",
      arguments: {
        device: "d1",
        project: "p1",
        command: "build_echo",
        variant: "default",
        requestKey: "build-echo-1",
      },
    }),
  );
  assert.equal(started.state, "running");
  assert.equal(started.gate, "command:build_echo:default:build");

  let done = started;
  for (let i = 0; i < 40 && done.state === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    done = content(
      await client.callTool({
        name: "get_job_status",
        arguments: { device: "d1", project: "p1", job: started.id },
      }),
    );
  }
  assert.equal(done.state, "succeeded");
  assert.match(done.output, /BUILD_OK/);
  assert.ok(!done.output.includes("supersecret"));
  assert.match(done.output, /token=\[REDACTED\]/);

  const replay = content(
    await client.callTool({
      name: "run_project_command",
      arguments: {
        device: "d1",
        project: "p1",
        command: "build_echo",
        variant: "default",
        requestKey: "build-echo-1",
      },
    }),
  );
  assert.equal(replay.id, started.id);

  const denied = await client.callTool({
    name: "run_project_command",
    arguments: {
      device: "d1",
      project: "p1",
      command: "build_echo",
      variant: "not_allowed",
      requestKey: "build-echo-denied",
    },
  });
  assert.equal(denied.isError, true);
  assert.equal(content(denied).error, "COMMAND_NOT_ALLOWED");
});

test("account diagnostics expose safe membership and same-tenant agent visibility", async (t) => {
  const { client } = await setup(t);
  const result = content(
    await client.callTool({ name: "account_diagnostics", arguments: {} }),
  );

  assert.equal(result.dynamic, false);
  assert.equal(result.subject, null);
  assert.deepEqual(result.memberships, [
    {
      tenant: "t1",
      permissions: ["execute", "read", "write"],
      devices: { d1: ["p1"] },
    },
  ]);
  assert.equal(result.visibleAgents.length, 1);
  assert.equal(result.visibleAgents[0].id, "d1");
  assert.equal(result.visibleAgents[0].tenant, "t1");
  assert.deepEqual(result.visibleAgents[0].projects, []);
  assert.equal(result.visibleAgents[0].online, true);
  assert.equal(result.visibleAgents[0].dynamic, false);
});

test("device listing includes safe account context for visibility diagnostics", async (t) => {
  const { client } = await setup(t);
  const result = content(
    await client.callTool({ name: "list_devices", arguments: {} }),
  );

  assert.deepEqual(result.account, {
    tenants: ["t1"],
    explicitDeviceGrants: { d1: ["p1"] },
  });
  assert.ok(result.devices.some((device) => device.id === "d1"));
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

test("healthy agent does not rewrite connection state without a reconnect", async (t) => {
  const { client, dir } = await setup(t);
  const state = path.join(dir, "state", "connection.json");
  for (let i = 0; i < 20 && !fs.existsSync(state); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(state));
  const before = fs.readFileSync(state, "utf8");
  const realNow = Date.now;
  Date.now = () => realNow() + 31000;
  try {
    const result = await client.callTool({
      name: "read_file",
      arguments: { device: "d1", project: "p1", path: "hello.txt" },
    });
    assert.equal(content(result).content, "hello");
  } finally {
    Date.now = realNow;
  }
  assert.equal(
    fs.readFileSync(state, "utf8"),
    before,
    "healthy traffic must not rewrite connection.json",
  );
});

test("agent immediately re-polls after a successful dispatch", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-fast-repoll-"));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "hello.txt"), "fast");
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    users: [
      {
        id: "u1",
        tenant: "t1",
        tokenHash: digest(userToken),
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
    pollMs: 500,
    projects: [{ id: "p1", root, writable: true, gates: {} }],
    license: { mode: "free" },
  });
  const client = new Client({ name: "fast-repoll-test", version: "1.0" });
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

  const args = {
    device: "d1",
    project: "p1",
    path: "hello.txt",
  };
  assert.equal(
    content(await client.callTool({ name: "read_file", arguments: args }))
      .content,
    "fast",
  );
  const started = Date.now();
  assert.equal(
    content(await client.callTool({ name: "read_file", arguments: args }))
      .content,
    "fast",
  );
  assert.ok(
    Date.now() - started < 250,
    "successful dispatch should not sleep for pollMs before polling again",
  );
});

test("gateway empty agent poll timeout is configurable", async (t) => {
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    pollWaitMs: 50,
    users: [
      {
        id: "u1",
        tenant: "t1",
        tokenHash: digest(userToken),
        devices: {},
        permissions: ["read"],
      },
    ],
    agents: [{ id: "d1", tenant: "t1", tokenHash: digest(agentToken) }],
  });
  t.after(async () => gw.close());

  const started = Date.now();
  const response = await fetch(gw.url + "/agent/poll", {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentToken}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(500),
  });
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  assert.ok(elapsed >= 35, `empty poll returned too quickly: ${elapsed}ms`);
  assert.ok(elapsed < 300, `empty poll ignored pollWaitMs: ${elapsed}ms`);
});

test("project snapshot combines capabilities, directory map and git status", async (t) => {
  const { client, root } = await setup(t);
  const { execFileSync } = await import("node:child_process");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "app.js"),
    "export const ready = true;\n",
  );
  fs.writeFileSync(path.join(root, ".env"), "SECRET=hidden\n");
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
      "snapshot baseline",
    ],
    { cwd: root, stdio: "pipe" },
  );
  fs.writeFileSync(path.join(root, "hello.txt"), "changed\n");

  const snapshot = content(
    await client.callTool({
      name: "project_snapshot",
      arguments: { device: "d1", project: "p1", maxEntries: 20 },
    }),
  );

  assert.equal(snapshot.device, "d1");
  assert.equal(snapshot.project, "p1");
  assert.equal(snapshot.writable, true);
  assert.deepEqual(snapshot.gates, ["unit"]);
  assert.equal(snapshot.git.available, true);
  assert.match(snapshot.git.status, /hello\.txt/);
  assert.ok(snapshot.entries.some((entry) => entry.name === "src"));
  assert.ok(!snapshot.entries.some((entry) => entry.name === ".env"));
  assert.equal(typeof snapshot.entriesTruncated, "boolean");
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

test("repository map ranks relevant symbols without exposing denied files", async (t) => {
  const { client, root } = await setup(t);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(
    path.join(root, "src", "auth.ts"),
    [
      "export interface Session { id: string }",
      "export async function authenticate(user: string) { return user; }",
      "export class SessionManager {}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "src", "billing.ts"),
    "export function invoice() { return true; }\n",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "repo-map-fixture" }),
  );
  fs.writeFileSync(path.join(root, ".env"), "AUTH_SECRET=must-not-appear\n");
  fs.writeFileSync(
    path.join(root, "node_modules", "ignored.js"),
    "function authenticateSecret() {}\n",
  );

  const result = content(
    await client.callTool({
      name: "repo_map",
      arguments: {
        device: "d1",
        project: "p1",
        query: "auth",
        maxFiles: 10,
        maxSymbolsPerFile: 8,
      },
    }),
  );

  assert.equal(result.files[0].path, "src/auth.ts");
  assert.ok(
    result.files[0].symbols.some(
      (symbol) => symbol.name === "authenticate" && symbol.kind === "function",
    ),
  );
  assert.ok(
    result.files[0].symbols.some(
      (symbol) => symbol.name === "SessionManager" && symbol.kind === "class",
    ),
  );
  assert.ok(result.files.some((file) => file.path === "package.json"));
  assert.ok(!result.files.some((file) => file.path === ".env"));
  assert.ok(!result.files.some((file) => file.path.includes("node_modules")));
  assert.ok(!JSON.stringify(result).includes("must-not-appear"));
  assert.equal(typeof result.scannedBytes, "number");
  assert.equal(typeof result.truncated, "boolean");
});

test("repository map stays bounded on large candidate sets", async (t) => {
  const { client, root } = await setup(t);
  fs.mkdirSync(path.join(root, "src"));
  for (let i = 0; i < 12; i++)
    fs.writeFileSync(
      path.join(root, "src", `file-${i}.js`),
      `export function fn${i}() { return ${i}; }\n`,
    );

  const result = content(
    await client.callTool({
      name: "repo_map",
      arguments: {
        device: "d1",
        project: "p1",
        maxFiles: 3,
        maxSymbolsPerFile: 2,
      },
    }),
  );

  assert.equal(result.files.length, 3);
  assert.equal(result.count, 3);
  assert.ok(result.candidateFiles >= 12);
  assert.equal(result.truncated, true);
});

test("context pack is delta-first, bounded and deterministic", async (t) => {
  const { client, root } = await setup(t);
  const { execFileSync } = await import("node:child_process");

  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "auth.ts"),
    [
      "export interface Session { id: string }",
      "export async function authenticate(user: string) {",
      "  return user;",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "src", "billing.ts"),
    "export function invoice() { return true; }\n",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "context-pack-fixture" }),
  );
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=must-not-appear\n");

  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  execFileSync(
    "git",
    ["add", "src/auth.ts", "src/billing.ts", "package.json", ".env"],
    { cwd: root, stdio: "pipe" },
  );
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "baseline",
    ],
    { cwd: root, stdio: "pipe" },
  );

  fs.appendFileSync(
    path.join(root, "src", "auth.ts"),
    "export const authVersion = 2;\n",
  );
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=changed-secret\n");

  const first = content(
    await client.callTool({
      name: "context_pack",
      arguments: {
        device: "d1",
        project: "p1",
        query: "authenticate",
        budget: "small",
      },
    }),
  );

  assert.equal(first.budget, "small");
  assert.equal(first.git.available, true);
  assert.equal(first.git.dirty, true);
  assert.match(first.git.head, /^[a-f0-9]{40}$/);
  assert.match(first.contextKey, /^[a-f0-9]{64}$/);
  assert.equal(first.cacheable, true);
  assert.ok(first.bytes <= first.budgetBytes);
  assert.ok(first.changedFiles.includes("src/auth.ts"));
  assert.ok(!first.changedFiles.includes(".env"));
  assert.equal(first.files[0].path, "src/auth.ts");
  assert.equal(first.files[0].changed, true);
  assert.ok(
    first.files.some((entry) =>
      entry.symbols.some((symbol) => symbol.name === "authenticate"),
    ),
  );
  assert.ok(!JSON.stringify(first).includes("changed-secret"));
  assert.ok(!JSON.stringify(first).includes("must-not-appear"));

  const repeated = content(
    await client.callTool({
      name: "context_pack",
      arguments: {
        device: "d1",
        project: "p1",
        query: "authenticate",
        budget: "small",
      },
    }),
  );
  assert.equal(repeated.contextKey, first.contextKey);

  fs.appendFileSync(
    path.join(root, "src", "billing.ts"),
    "export const billingVersion = 2;\n",
  );
  const changed = content(
    await client.callTool({
      name: "context_pack",
      arguments: {
        device: "d1",
        project: "p1",
        query: "authenticate",
        budget: "small",
      },
    }),
  );
  assert.notEqual(changed.contextKey, first.contextKey);
  assert.ok(changed.changedFiles.includes("src/billing.ts"));
});

test("batch reads return multiple bounded files in one MCP call", async (t) => {
  const { client, root } = await setup(t);
  fs.writeFileSync(path.join(root, "a.txt"), "a1\na2\na3\n");
  fs.writeFileSync(path.join(root, "b.txt"), "b1\nb2\n");

  const result = content(
    await client.callTool({
      name: "read_files_batch",
      arguments: {
        device: "d1",
        project: "p1",
        files: [
          { path: "a.txt", startLine: 2, maxLines: 2 },
          { path: "b.txt" },
        ],
      },
    }),
  );

  assert.equal(result.count, 2);
  assert.equal(result.files[0].content, "a2\na3");
  assert.equal(result.files[1].content, "b1\nb2\n");
  assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(result.files[1].sha256, /^[a-f0-9]{64}$/);
});

test("atomic multi-file write commits all changes or none", async (t) => {
  const { client, root } = await setup(t);
  fs.writeFileSync(path.join(root, "one.txt"), "one\n");
  fs.writeFileSync(path.join(root, "two.txt"), "two\n");

  const one = content(
    await client.callTool({
      name: "read_file",
      arguments: { device: "d1", project: "p1", path: "one.txt" },
    }),
  );
  const two = content(
    await client.callTool({
      name: "read_file",
      arguments: { device: "d1", project: "p1", path: "two.txt" },
    }),
  );

  const changed = await client.callTool({
    name: "write_files_atomic",
    arguments: {
      device: "d1",
      project: "p1",
      changes: [
        { path: "one.txt", content: "ONE\n", expectedHash: one.sha256 },
        { path: "two.txt", content: "TWO\n", expectedHash: two.sha256 },
        { path: "new.txt", content: "NEW\n", expectedHash: null },
      ],
    },
  });
  assert.equal(changed.isError, undefined);
  assert.equal(fs.readFileSync(path.join(root, "one.txt"), "utf8"), "ONE\n");
  assert.equal(fs.readFileSync(path.join(root, "two.txt"), "utf8"), "TWO\n");
  assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "NEW\n");

  const oneAfter = content(
    await client.callTool({
      name: "read_file",
      arguments: { device: "d1", project: "p1", path: "one.txt" },
    }),
  );
  fs.writeFileSync(path.join(root, "two.txt"), "externally changed\n");
  const rejected = await client.callTool({
    name: "write_files_atomic",
    arguments: {
      device: "d1",
      project: "p1",
      changes: [
        {
          path: "one.txt",
          content: "must-not-change\n",
          expectedHash: oneAfter.sha256,
        },
        { path: "two.txt", content: "also-no\n", expectedHash: two.sha256 },
      ],
    },
  });
  assert.equal(content(rejected).error, "CONTENT_CONFLICT");
  assert.equal(fs.readFileSync(path.join(root, "one.txt"), "utf8"), "ONE\n");
  assert.equal(
    fs.readFileSync(path.join(root, "two.txt"), "utf8"),
    "externally changed\n",
  );
});

test("bounded git log and show expose recent history without shell helpers", async (t) => {
  const { client, root } = await setup(t);
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
      "initial history",
    ],
    { cwd: root, stdio: "pipe" },
  );

  const log = content(
    await client.callTool({
      name: "git_log",
      arguments: { device: "d1", project: "p1", limit: 5 },
    }),
  );
  assert.match(log.log, /initial history/);
  const commit = log.log.split("\t")[0];
  assert.match(commit, /^[a-f0-9]{40}$/);

  const shown = content(
    await client.callTool({
      name: "git_show",
      arguments: { device: "d1", project: "p1", commit },
    }),
  );
  assert.match(shown.show, /initial history/);
  assert.match(shown.show, /hello\.txt/);
  assert.equal(typeof shown.truncated, "boolean");
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
test("account-authorized devices remain discoverable while offline", async (t) => {
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    users: [
      {
        id: "u1",
        tenant: "t1",
        tokenHash: digest(userToken),
        devices: { paired: ["project1"] },
        permissions: ["read"],
      },
    ],
    agents: [{ id: "seed", tenant: "t1", tokenHash: digest(agentToken) }],
  });
  const client = new Client({ name: "offline-discovery", version: "1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", gw.url), {
      requestInit: { headers: { Authorization: `Bearer ${userToken}` } },
    }),
  );
  t.after(async () => {
    await client.close();
    await gw.close();
  });

  assert.deepEqual(
    content(await client.callTool({ name: "list_devices", arguments: {} }))
      .devices,
    [{ id: "paired", projects: ["project1"], online: false }],
  );
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
        permissions: ["read", "write", "execute"],
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

test("MCP server advertises a configured icon URL and omits it when unset", async (t) => {
  const { client: defaultClient } = await setup(t);
  const defaultServer = defaultClient.getServerVersion();
  assert.equal(defaultServer?.icons, undefined);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-icon-"));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    iconUrl: "https://kmjtechno.com/assets/kmj-codebridge-icon.png",
    users: [
      {
        id: "u1",
        tenant: "t1",
        tokenHash: digest(userToken),
        devices: { d1: ["p1"] },
        permissions: ["read"],
      },
    ],
    agents: [{ id: "d1", tenant: "t1", tokenHash: digest(agentToken) }],
  });
  const client = new Client({ name: "icon-test", version: "1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", gw.url), {
      requestInit: { headers: { Authorization: `Bearer ${userToken}` } },
    }),
  );
  t.after(async () => {
    await client.close();
    await gw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const server = client.getServerVersion();
  assert.deepEqual(server?.icons, [
    {
      src: "https://kmjtechno.com/assets/kmj-codebridge-icon.png",
      mimeType: "image/png",
    },
  ]);
});

test("gateway configuration rejects a local/loopback icon URL", async () => {
  const { gatewaySchema } = await import("../src/config.js");
  assert.throws(() =>
    gatewaySchema.parse({
      users: [
        {
          id: "u1",
          tenant: "t1",
          tokenHash: digest(userToken),
          devices: {},
          permissions: ["read"],
        },
      ],
      agents: [{ id: "d1", tenant: "t1", tokenHash: digest(agentToken) }],
      iconUrl: "https://127.0.0.1/icon.png",
    }),
  );
});
