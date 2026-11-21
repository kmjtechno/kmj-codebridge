import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";
import { assertSupervisorProjectSocketScope } from "../src/agent.js";
import {
  isAuthorizedSupervisorSocket,
  ELITE_DEV_SUPERVISOR_SOCKET,
  ELITE_CLOUDOS_SUPERVISOR_SOCKET,
  SUPERVISOR_SOCKET,
} from "../src/supervisor-client.js";
import { enrolledAgentSchema } from "../src/config.js";

const UNIT = "kmj-codebridge-dev.service";

function fixture(state = "active") {
  const calls = [];
  const h = createSupervisorHandler({
    profile: "codebridge-dev-elite",
    run: (binary, args) => {
      calls.push({ binary, args });
      assert.equal(binary, "/usr/bin/systemctl");
      assert.equal(args[1], UNIT);
      if (args.includes("--property=LoadState"))
        return "LoadState=loaded\nActiveState=" + state + "\n";
      return (
        "ActiveState=" + state + "\nSubState=running\nMainPID=21\nNRestarts=0\n"
      );
    },
    restart: () => {
      throw Error("RESTART_FORBIDDEN");
    },
    readFile: () => {
      throw Error("CONFIG_READ_FORBIDDEN");
    },
    readLog: () => {
      throw Error("LOG_READ_FORBIDDEN");
    },
    statfs: (target) => {
      assert.equal(target, "/var/lib/kmj-codebridge-dev");
      return { bsize: 4096, blocks: 100, bavail: 40 };
    },
  });
  return { h, calls };
}

test("Elite dev profile only targets the fixed kmjdev agent", async () => {
  const { h, calls } = fixture();
  const response = (await h({ op: "status", service: "agent" })).response;
  assert.equal(response.service, "agent");
  assert.equal(response.activeState, "active");
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every((call) => call.binary === "/usr/bin/systemctl" && call.args[1] === UNIT),
  );
  for (const service of ["gateway", "kmj-main-platform", "kmj-cloudos"]) {
    await assert.rejects(
      h({ op: "status", service }),
      /SUPERVISOR_SERVICE_NOT_ALLOWED/,
    );
  }
});

test("Elite dev profile refuses every privileged or project-file operation", async () => {
  const { h, calls } = fixture();
  for (const request of [
    { op: "restart", service: "agent" },
    { op: "logs", service: "agent", lines: 1 },
    { op: "config_validate", service: "agent" },
    { op: "project_status", projectId: "kmj-codebridge" },
    { op: "project_status", projectId: "kmj-main-platform" },
    { op: "main_platform_production_activate" },
    { op: "main_platform_refresh" },
    { op: "main_platform_offsite_diagnostic" },
    { op: "development_ci_start" },
    { op: "private_pr322_ci_start" },
    { op: "update_now" },
    { op: "update_rollback" },
    { op: "shell", command: "whoami" },
  ]) {
    await assert.rejects(
      h(request),
      /(?:SUPERVISOR_OPERATION_NOT_ALLOWED|INVALID_SUPERVISOR_REQUEST)/,
    );
  }
  assert.equal(calls.length, 0, "denied actions never touch systemd");
});

test("Elite dev profile offers only bounded resource inventory", async () => {
  const { h } = fixture();
  assert.equal(typeof (await h({ op: "device_status" })).response.cpuCount, "number");
  const disk = (await h({ op: "disk_space" })).response;
  assert.equal(disk.target, "/var/lib/kmj-codebridge-dev");
  assert.equal(disk.totalBytes, 409600);
  assert.equal(disk.freeBytes, 163840);
});

test("Elite dev profile never falls back to another loaded agent", async () => {
  const h = createSupervisorHandler({
    profile: "codebridge-dev-elite",
    run: () => "LoadState=not-found\nActiveState=inactive\n",
  });
  await assert.rejects(
    h({ op: "status", service: "agent" }),
    /SUPERVISOR_SERVICE_UNAVAILABLE/,
  );
  assert.throws(
    () => createSupervisorHandler({ profile: "codebridge-dev-admin" }),
    /SUPERVISOR_PROFILE_INVALID/,
  );
});

test("dedicated Elite dev socket is a Linux exact-match allowlist entry", () => {
  for (const socket of [
    SUPERVISOR_SOCKET,
    ELITE_CLOUDOS_SUPERVISOR_SOCKET,
    ELITE_DEV_SUPERVISOR_SOCKET,
  ])
    assert.equal(isAuthorizedSupervisorSocket(socket, "linux"), true);
  for (const socket of [
    "/run/kmj-codebridge-dev/../kmj-codebridge/supervisor.sock",
    "/run/kmj-codebridge-dev/supervisor.sock/",
    "/tmp/agent.sock",
    "/run/kmj-codebridge-dev/supervisor.sock.other",
  ])
    assert.equal(isAuthorizedSupervisorSocket(socket, "linux"), false);
  assert.equal(isAuthorizedSupervisorSocket(ELITE_DEV_SUPERVISOR_SOCKET, "win32"), false);
  const schema = enrolledAgentSchema.shape.supervisorSocket;
  assert.equal(schema.safeParse(ELITE_DEV_SUPERVISOR_SOCKET).success, true);
  assert.equal(schema.safeParse("/tmp/dev.sock").success, false);
});

test("dedicated Supervisor sockets require one matching project, no cross-tenant reuse", () => {
  for (const projects of [
    [],
    [{ id: "kmj-main-platform" }],
    [{ id: "kmj-codebridge" }, { id: "kmj-cloudos" }],
  ]) {
    assert.throws(
      () => assertSupervisorProjectSocketScope({
        supervisorSocket: ELITE_DEV_SUPERVISOR_SOCKET,
        projects,
      }),
      /ELITE_DEV_SUPERVISOR_PROJECT_MISMATCH/,
    );
  }
  assert.doesNotThrow(() =>
    assertSupervisorProjectSocketScope({
      supervisorSocket: ELITE_DEV_SUPERVISOR_SOCKET,
      projects: [{ id: "kmj-codebridge" }],
    }),
  );
  assert.throws(
    () => assertSupervisorProjectSocketScope({
      supervisorSocket: ELITE_CLOUDOS_SUPERVISOR_SOCKET,
      projects: [{ id: "kmj-codebridge" }],
    }),
    /ELITE_CLOUDOS_SUPERVISOR_PROJECT_MISMATCH/,
  );
});
