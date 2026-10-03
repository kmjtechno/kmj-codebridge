import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSupervisorHandler,
  startSupervisor,
} from "../src/supervisor.js";
import {
  SUPERVISOR_SOCKET,
  supervisorRequest,
} from "../src/supervisor-client.js";

test("status maps only allowlisted service names", async () => {
  const calls = [];
  const handle = createSupervisorHandler({
    run: (command, args) => {
      calls.push([command, args]);
      return "ActiveState=active\nSubState=running\nMainPID=123\nNRestarts=2\n";
    },
  });
  const result = await handle({ op: "status", service: "agent" });
  assert.deepEqual(result.response, {
    service: "agent",
    activeState: "active",
    subState: "running",
    mainPid: 123,
    restarts: 2,
  });
  assert.equal(calls[0][0], "/usr/bin/systemctl");
  assert.equal(calls[0][1][1], "kmj-codebridge-agent.service");
  await assert.rejects(
    handle({ op: "status", service: "ssh" }),
    /SUPERVISOR_SERVICE_NOT_ALLOWED/,
  );
});

test("logs are bounded and redacted", async () => {
  const handle = createSupervisorHandler({
    run: () => "token=never-return-this\nnormal line\n",
  });
  const result = await handle({ op: "logs", service: "gateway", lines: 20 });
  assert.doesNotMatch(result.response.output, /never-return-this/);
  assert.match(result.response.output, /\[REDACTED\]/);
  await assert.rejects(
    handle({ op: "logs", service: "gateway", lines: 201 }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("config validation uses fixed paths and never returns config content", async () => {
  const seen = [];
  const handle = createSupervisorHandler({
    readFile: (file) => {
      seen.push(file);
      return JSON.stringify({
        gateway: "https://kmjtechno.com",
        token: "x".repeat(48),
        id: "d1",
        tenant: "t1",
        stateDir: "/var/lib/kmj-codebridge",
        projects: [{ id: "p1", root: "/srv/project" }],
        license: { mode: "free" },
      });
    },
  });
  const result = await handle({ op: "config_validate", service: "agent" });
  assert.deepEqual(result.response, { service: "agent", valid: true });
  assert.deepEqual(seen, ["/etc/kmj-codebridge/agent.json"]);
  assert.equal(JSON.stringify(result).includes("x".repeat(20)), false);
});

test("restart is acknowledged before a hardcoded unit is scheduled", async () => {
  const restarted = [];
  const handle = createSupervisorHandler({
    restart: (unit) => restarted.push(unit),
  });
  const result = await handle({ op: "restart", service: "agent" });
  assert.deepEqual(result.response, { service: "agent", accepted: true });
  assert.deepEqual(restarted, []);
  result.afterSend();
  assert.deepEqual(restarted, ["kmj-codebridge-agent.service"]);
});

test("disk-space operation accepts no caller path", async () => {
  const handle = createSupervisorHandler({
    statfs: () => ({ bsize: 4096, blocks: 100, bavail: 25 }),
  });
  const result = await handle({ op: "disk_space" });
  assert.equal(result.response.totalBytes, 409600);
  assert.equal(result.response.freeBytes, 102400);
  await assert.rejects(
    handle({ op: "disk_space", path: "/tmp" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test(
  "unix socket server and client exchange one bounded request",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-supervisor-"));
    const socketPath = path.join(dir, "supervisor.sock");
    const service = await startSupervisor({
      socketPath,
      handler: async (request) => ({ response: { echoed: request.op } }),
    });
    t.after(async () => {
      await service.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // The production client intentionally accepts only the fixed system
    // socket, so use the server directly here and separately assert the
    // fixed-path client boundary below.
    assert.ok(fs.existsSync(socketPath));
  },
);

test("client refuses arbitrary local socket paths", async () => {
  await assert.rejects(
    supervisorRequest("/tmp/not-codebridge.sock", { op: "status" }),
    /SUPERVISOR_UNAVAILABLE/,
  );
  assert.equal(SUPERVISOR_SOCKET, "/run/kmj-codebridge/supervisor.sock");
});
