import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { startAgent } from "../src/agent.js";
import {
  AgentUpdateGuard,
  acquireUpdateMaintenance,
} from "../src/update-maintenance.js";

// Real agent HTTP poll/dispatch/result lifecycle. Only the Linux /proc boundary
// and Supervisor status are supplied because this sandbox virtualizes /proc.
test(
  "agent holds drain until result delivery and a replacement stays paused",
  { skip: process.platform !== "linux", timeout: 8000 },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "cb-agent-maintenance-"),
    );
    const project = path.join(root, "project"),
      stateDir = path.join(root, "state"),
      control = path.join(root, "control");
    fs.mkdirSync(project);
    fs.mkdirSync(control, { mode: 0o755 });
    const requestPath = path.join(control, "maintenance", "request.json");
    const options = {
      requestPath,
      trustedUid: process.getuid(),
      identify: (pid) =>
        pid === process.pid
          ? { id: "test-boot:42", uid: process.getuid() }
          : null,
    };
    let agent, lease, guard, releaseResult;
    let generation = 0;
    let currentToken;
    let pending = [
      {
        id: "first",
        tool: "project_environment",
        args: { device: "d", project: "p" },
        permissions: ["read"],
      },
    ];
    const results = [];
    const server = http.createServer(async (req, res) => {
      let input = "";
      for await (const chunk of req) input += chunk;
      res.setHeader("content-type", "application/json");
      if (req.url === "/agent/result") {
        const r = JSON.parse(input);
        results.push(r);
        if (r.id === "first") {
          releaseResult = () => res.end("{}");
          return;
        }
      }
      res.end(
        JSON.stringify(
          req.url === "/agent/poll" &&
            req.headers.authorization === `Bearer ${currentToken}`
            ? (pending.shift() ?? null)
            : {},
        ),
      );
    });
    t.after(async () => {
      lease?.close();
      await agent?.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(root, { recursive: true, force: true });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const config = {
      gateway: `http://127.0.0.1:${server.address().port}`,
      token: "a".repeat(48),
      id: "d",
      tenant: "t",
      stateDir,
      pollMs: 10,
      projects: [{ id: "p", root: project, writable: true, gates: {} }],
      license: { mode: "free" },
    };
    const start = () => {
      // A cancelled old HTTP poll must not consume the new instance's work in
      // this fixture. Production gateway forwarding has its own delivery queue.
      currentToken = `${++generation}`.padEnd(48, "a");
      return startAgent(
        { ...config, token: currentToken },
        {
          createUpdateGuard: (args) => {
            guard = new AgentUpdateGuard({ ...args, ...options });
            return guard;
          },
        },
      );
    };
    const wait = async (predicate) => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail("condition timed out");
    };
    agent = await start();
    await wait(() => Boolean(releaseResult));
    assert.equal(results[0].result.isError, undefined);
    lease = acquireUpdateMaintenance(
      { agentStateDir: stateDir },
      {
        ...options,
        status: async () => ({ activeState: "active", mainPid: process.pid }),
        attempts: 100,
        sleep: async () => {
          await new Promise((r) => setTimeout(r, 10));
          guard.refresh();
        },
      },
    );
    const drained = lease.drain();
    guard.refresh();
    assert.equal(
      fs.existsSync(path.join(stateDir, "update-drained.json")),
      false,
      "in-flight result response must keep drain busy",
    );
    releaseResult();
    await drained;
    await agent.close();
    agent = await start();
    pending.push({
      id: "paused",
      tool: "project_environment",
      args: { device: "d", project: "p" },
      permissions: ["read"],
    });
    await wait(() => results.some((r) => r.id === "paused"));
    assert.equal(results.find((r) => r.id === "paused").result.isError, true);
    assert.match(
      results.find((r) => r.id === "paused").result.content[0].text,
      /UPDATE_MAINTENANCE/,
    );
    lease.close();
    lease = null;
    pending.push({
      id: "resumed",
      tool: "project_environment",
      args: { device: "d", project: "p" },
      permissions: ["read"],
    });
    await wait(() => results.some((r) => r.id === "resumed"));
    assert.equal(
      results.find((r) => r.id === "resumed").result.isError,
      undefined,
    );
  },
);
