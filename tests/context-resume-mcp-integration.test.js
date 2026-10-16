// SDK-level (local loopback) acceptance for the actual context_resume tool
// registration, gateway forwarding, authenticated device agent, and ifNoneMatch.
// NOT live customer-domain OAuth, ChatGPT account auth, or production deployment.
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

const hash = (value) => createHash("sha256").update(value).digest("hex");
const userToken = "u".repeat(48);
const agentToken = "a".repeat(48);
const scope = { device: "d1", project: "p1" };

const value = (result) => {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
};

test("real MCP SDK context_resume returns delta only on the same digest", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-resume-mcp-"));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  let gateway;
  let agent;
  let client;
  t.after(async () => {
    try {
      if (client) await client.close();
    } finally {
      try {
        if (agent) await agent.close();
      } finally {
        if (gateway) await gateway.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    users: [
      {
        id: "u1",
        tenant: "t1",
        tokenHash: hash(userToken),
        devices: { d1: ["p1"] },
        permissions: ["read", "write"],
      },
    ],
    agents: [{ id: "d1", tenant: "t1", tokenHash: hash(agentToken) }],
  });
  agent = await startAgent({
    gateway: gateway.url,
    token: agentToken,
    id: "d1",
    tenant: "t1",
    stateDir: path.join(dir, "state"),
    pollMs: 10,
    projects: [{ id: "p1", root, writable: true, gates: {}, commands: {} }],
    license: { mode: "free" },
  });
  client = new Client({ name: "resume-sdk-test", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("/mcp", gateway.url),
    { requestInit: { headers: { Authorization: `Bearer ${userToken}` } } },
  );
  await client.connect(transport);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "context_resume"));

  const full = value(
    await client.callTool({
      name: "context_resume",
      arguments: scope,
    }),
  );
  assert.equal(full.kind, "codebridge.context_resume");
  assert.equal(full.version, 1);
  assert.match(full.digest, /^[a-f0-9]{64}$/);
  assert.equal(full.mailbox.actorLabelsVerified, false);
  assert.equal(full.git, "UNKNOWN");

  const unchanged = value(
    await client.callTool({
      name: "context_resume",
      arguments: { ...scope, ifNoneMatch: full.digest },
    }),
  );
  assert.deepEqual(unchanged, {
    version: 1,
    kind: "codebridge.context_resume",
    device: "d1",
    project: "p1",
    unchanged: true,
    digest: full.digest,
  });
  assert.ok(JSON.stringify(unchanged).length < JSON.stringify(full).length);

  const posted = value(
    await client.callTool({
      name: "coordination_post",
      arguments: {
        ...scope,
        actor: "test-worker",
        recipient: "chatgpt",
        requestKey: "resume-delta-event-1",
        kind: "result",
        note: "new evidence is ready",
        reportedGate: "unknown",
      },
    }),
  );
  assert.equal(posted.stored, true);

  const changed = value(
    await client.callTool({
      name: "context_resume",
      arguments: { ...scope, ifNoneMatch: full.digest },
    }),
  );
  assert.equal(changed.unchanged, undefined);
  assert.match(changed.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(changed.digest, full.digest);
  assert.equal(changed.mailbox.totalStored, 1);
  assert.equal(changed.mailbox.actorLabelsVerified, false);
  assert.equal(changed.mailbox.recent[0].note, "new evidence is ready");

  // Chat A and chat B can independently remember short state without
  // replaying the full conversation, then use one read-only sync tool.
  assert.ok(tools.tools.some((tool) => tool.name === "multi_chat_sync"));
  const initialSync = value(
    await client.callTool({
      name: "multi_chat_sync",
      arguments: { ...scope, lane: "chatA" },
    }),
  );
  assert.equal(initialSync.checkpoint.exists, false);
  assert.equal(initialSync.hostChatAutoWake, false);
  const savedA = value(
    await client.callTool({
      name: "chat_continuity_save",
      arguments: {
        ...scope,
        lane: "chatA",
        requestKey: "checkpoint-A1",
        expectedRevision: null,
        summary: "Approved project engineering checkpoint",
        next: "Verify tests before merge",
        blockers: ["Waiting for review"],
      },
    }),
  );
  assert.match(savedA.revision, /^[a-f0-9]{64}$/);
  const savedB = value(
    await client.callTool({
      name: "chat_continuity_save",
      arguments: {
        ...scope,
        lane: "chatB",
        requestKey: "checkpoint-B1",
        expectedRevision: null,
        summary: "Independent second chat",
        next: "Review separate files",
        blockers: [],
      },
    }),
  );
  assert.notEqual(savedB.revision, savedA.revision);
  const currentA = value(
    await client.callTool({
      name: "multi_chat_sync",
      arguments: { ...scope, lane: "chatA", ifNoneMatch: initialSync.digest },
    }),
  );
  assert.equal(
    currentA.checkpoint.summary,
    "Approved project engineering checkpoint",
  );
  assert.equal(currentA.checkpoint.revision, savedA.revision);
  assert.notEqual(currentA.digest, initialSync.digest);
  const tiny = value(
    await client.callTool({
      name: "multi_chat_sync",
      arguments: { ...scope, lane: "chatA", ifNoneMatch: currentA.digest },
    }),
  );
  assert.equal(tiny.unchanged, true);
  assert.equal(tiny.digest, currentA.digest);
  assert.ok(JSON.stringify(tiny).length < JSON.stringify(currentA).length / 3);
  const currentB = value(
    await client.callTool({
      name: "multi_chat_sync",
      arguments: { ...scope, lane: "chatB" },
    }),
  );
  assert.equal(currentB.checkpoint.summary, "Independent second chat");
  assert.equal(currentB.checkpoint.revision, savedB.revision);
});
