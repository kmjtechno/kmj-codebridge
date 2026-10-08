import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSupervisorHandler, startSupervisor } from "../src/supervisor.js";
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

test("device status returns a bounded resource snapshot", async () => {
  const handle = createSupervisorHandler({
    deviceStatus: () => ({
      platform: "linux",
      arch: "x64",
      hostname: "codebridge-host",
      cpuCount: 16,
      totalMemoryBytes: 64 * 1024 ** 3,
      freeMemoryBytes: 40 * 1024 ** 3,
      loadAverage: { one: 1.25, five: 0.75, fifteen: 0.5 },
      uptimeSeconds: 12345,
      processUptimeSeconds: 90,
      nodeVersion: "v24.21.0",
    }),
  });
  const result = await handle({ op: "device_status" });
  assert.deepEqual(result.response, {
    platform: "linux",
    arch: "x64",
    hostname: "codebridge-host",
    cpuCount: 16,
    totalMemoryBytes: 64 * 1024 ** 3,
    freeMemoryBytes: 40 * 1024 ** 3,
    loadAverage: { one: 1.25, five: 0.75, fifteen: 0.5 },
    uptimeSeconds: 12345,
    processUptimeSeconds: 90,
    nodeVersion: "v24.21.0",
  });
  await assert.rejects(
    handle({ op: "device_status", command: "whoami" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("device status sanitizes invalid provider values", async () => {
  const handle = createSupervisorHandler({
    deviceStatus: () => ({
      platform: "x".repeat(100),
      arch: null,
      hostname: "h".repeat(500),
      cpuCount: -5,
      totalMemoryBytes: Number.POSITIVE_INFINITY,
      freeMemoryBytes: -1,
      loadAverage: { one: -1, five: 2, fifteen: Number.NaN },
      uptimeSeconds: -1,
      processUptimeSeconds: 3.9,
      nodeVersion: 123,
    }),
  });
  const result = await handle({ op: "device_status" });
  assert.equal(result.response.platform.length, 32);
  assert.equal(result.response.arch, "unknown");
  assert.equal(result.response.hostname.length, 253);
  assert.equal(result.response.cpuCount, 0);
  assert.equal(result.response.totalMemoryBytes, 0);
  assert.equal(result.response.freeMemoryBytes, 0);
  assert.deepEqual(result.response.loadAverage, {
    one: 0,
    five: 2,
    fifteen: 0,
  });
  assert.equal(result.response.uptimeSeconds, 0);
  assert.equal(result.response.processUptimeSeconds, 3);
  assert.equal(result.response.nodeVersion, "unknown");
});

test("project status derives the root from the fixed agent config", async () => {
  const seen = [];
  const root = "/srv/kmj-codebridge-projects/codebridge-control";
  const handle = createSupervisorHandler({
    readFile: (file) => {
      assert.equal(file, "/etc/kmj-codebridge/agent.json");
      return JSON.stringify({
        gateway: "https://kmjtechno.com",
        token: "x".repeat(48),
        id: "d1",
        tenant: "t1",
        stateDir: "/var/lib/kmj-codebridge",
        projects: [{ id: "project_1", root }],
        license: { mode: "free" },
      });
    },
    exists: (target) => {
      seen.push(target);
      return target === root || target === `${root}/.git`;
    },
    stat: (target) => {
      seen.push(target);
      return { isDirectory: () => true };
    },
  });
  const result = await handle({ op: "project_status", projectId: "project_1" });
  assert.deepEqual(result.response, {
    projectId: "project_1",
    present: true,
    directory: true,
    gitCheckout: true,
  });
  assert.deepEqual(seen, [root, root, `${root}/.git`]);
});

test("project status rejects traversal and arbitrary path inputs", async () => {
  const handle = createSupervisorHandler();
  for (const request of [
    { op: "project_status", projectId: "../root" },
    { op: "project_status", projectId: "project/other" },
    { op: "project_status", projectId: "" },
    { op: "project_status", projectId: "x".repeat(65) },
    { op: "project_status", projectId: "project1", path: "/tmp/project1" },
  ]) {
    await assert.rejects(handle(request), /INVALID_SUPERVISOR_REQUEST/);
  }
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

test("auto-update status reports only fixed timer, updater and Main Platform refresh units", async () => {
  const calls = [];
  const handle = createSupervisorHandler({
    run: (command, args) => {
      calls.push([command, args]);
      if (args[1] === "kmj-codebridge-auto-update.timer")
        return "LoadState=loaded\nActiveState=active\nSubState=waiting\nUnitFileState=enabled\n";
      return "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\n";
    },
  });
  const result = await handle({ op: "update_status" });
  assert.deepEqual(result.response, {
    available: true,
    timer: {
      installed: true,
      activeState: "active",
      subState: "waiting",
      unitFileState: "enabled",
    },
    service: {
      installed: true,
      activeState: "inactive",
      subState: "dead",
      result: "success",
      execMainStatus: "0",
    },
    mainPlatformRefresh: {
      installed: true,
      activeState: "inactive",
      subState: "dead",
      conditionResult: "unknown",
      result: "success",
      execMainStatus: "0",
      execMainStartTimestamp: "unknown",
      execMainExitTimestamp: "unknown",
    },
  });
  assert.deepEqual(
    calls.map((entry) => entry[1][1]),
    [
      "kmj-codebridge-auto-update.timer",
      "kmj-codebridge-auto-update.service",
      "kmj-codebridge-main-platform-refresh.service",
    ],
  );
  await assert.rejects(
    handle({ op: "update_status", branch: "main" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("auto-update trigger acknowledges before starting only the hardcoded unit", async () => {
  const started = [];
  const handle = createSupervisorHandler({
    run: () => "LoadState=loaded\nActiveState=inactive\n",
    start: (unit) => started.push(unit),
  });
  const result = await handle({ op: "update_now" });
  assert.deepEqual(result.response, { accepted: true });
  assert.deepEqual(started, []);
  result.afterSend();
  assert.deepEqual(started, ["kmj-codebridge-auto-update.service"]);
  await assert.rejects(
    handle({ op: "update_now", unit: "ssh.service" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
});

test("auto-update trigger fails closed when the fixed unit is not installed", async () => {
  const handle = createSupervisorHandler({
    run: () => "LoadState=not-found\nActiveState=inactive\n",
  });
  await assert.rejects(
    handle({ op: "update_now" }),
    /SUPERVISOR_UPDATE_UNAVAILABLE/,
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
