import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";
import {
  isAuthorizedSupervisorSocket,
  ELITE_CLOUDOS_SUPERVISOR_SOCKET,
  SUPERVISOR_SOCKET,
} from "../src/supervisor-client.js";
import { enrolledAgentSchema } from "../src/config.js";

const UNIT = "kmj-codebridge-kmj-cloudos.service";

function fixture(state = "active") {
  const calls = [];
  const h = createSupervisorHandler({
    profile: "cloudos-elite",
    run: (binary, args) => {
      calls.push({ binary, args });
      assert.equal(binary, "/usr/bin/systemctl");
      assert.equal(args[1], UNIT);
      if (args.includes("--property=LoadState"))
        return "LoadState=loaded\nActiveState=" + state + "\n";
      return (
        "ActiveState=" + state + "\nSubState=running\nMainPID=17\nNRestarts=0\n"
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
    readlink: () => {
      throw Error("PATH_DISCOVERY_FORBIDDEN");
    },
  });
  return { h, calls };
}

test("Elite CloudOS supervisor is bound to exact existing agent only", async () => {
  const { h, calls } = fixture();
  const a = await h({ op: "status", service: "agent" });
  assert.equal(a.response.activeState, "active");
  assert.equal(a.response.service, "agent");
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every((c) => c.binary === "/usr/bin/systemctl" && c.args[1] === UNIT),
  );
  for (const service of ["gateway", "ssh", "kmj-main-platform"]) {
    await assert.rejects(
      h({ op: "status", service }),
      /SUPERVISOR_SERVICE_NOT_ALLOWED/,
    );
  }
});
test("Elite CloudOS profile denies ALL privilege-bearing and file RPCs", async () => {
  const { h, calls } = fixture();
  for (const request of [
    { op: "restart", service: "agent" },
    { op: "logs", service: "agent", lines: 10 },
    { op: "config_validate", service: "agent" },
    { op: "project_status", projectId: "kmj-main-platform" },
    { op: "project_status", projectId: "kmj-cloudos" },
    { op: "main_platform_production_activate" },
    { op: "main_platform_refresh" },
    { op: "main_platform_offsite_diagnostic" },
    { op: "development_ci_start" },
    { op: "private_pr322_ci_start" },
    { op: "update_now" },
    { op: "update_rollback" },
    { op: "fake", command: "/bin/sh" },
  ])
    await assert.rejects(h(request), /(?:SUPERVISOR_OPERATION_NOT_ALLOWED|INVALID_SUPERVISOR_REQUEST)/);
  assert.equal(calls.length, 0);
});
test("Elite CloudOS supervisor returns bounded platform and disk inventory only", async () => {
  const { h } = fixture();
  const d = await h({ op: "device_status" });
  assert.equal(typeof d.response.cpuCount, "number");
  const disk = await h({ op: "disk_space" });
  assert.equal(typeof disk.response.totalBytes, "number");
  assert.equal(typeof disk.response.freeBytes, "number");
});
test("unloaded or unexpected Elite unit never resolves another agent", async () => {
  const h = createSupervisorHandler({
    profile: "cloudos-elite",
    run: () => "LoadState=not-found\nActiveState=inactive\n",
  });
  await assert.rejects(
    h({ op: "status", service: "agent" }),
    /SUPERVISOR_SERVICE_UNAVAILABLE/,
  );
  assert.throws(
    () => createSupervisorHandler({ profile: "cloudos-admin" }),
    /SUPERVISOR_PROFILE_INVALID/,
  );
});
test("Linux Supervisor path allowlist is exactly existing and dedicated sockets", () => {
  for (const p of [SUPERVISOR_SOCKET, ELITE_CLOUDOS_SUPERVISOR_SOCKET])
    assert.equal(isAuthorizedSupervisorSocket(p, "linux"), true);
  for (const p of [
    "/run/kmj-codebridge-cloudos/../kmj-codebridge/supervisor.sock",
    "/run/kmj-codebridge-cloudos/supervisor.sock/",
    "/tmp/supervisor.sock",
    "/run/kmj-codebridge/supervisor.sock.other",
  ])
    assert.equal(isAuthorizedSupervisorSocket(p, "linux"), false);
  assert.equal(isAuthorizedSupervisorSocket(SUPERVISOR_SOCKET, "win32"), false);
  assert.equal(
    isAuthorizedSupervisorSocket(ELITE_CLOUDOS_SUPERVISOR_SOCKET, "win32"),
    false,
  );
});
test("enrollment schema permits only exact dedicated Linux socket", () => {
  // The profile itself is never caller-controlled; only a protected,
  // operator-installed systemd unit may select it.
  const schema = enrolledAgentSchema.shape.supervisorSocket;
  assert.equal(schema.safeParse(ELITE_CLOUDOS_SUPERVISOR_SOCKET).success, true);
  assert.equal(schema.safeParse(SUPERVISOR_SOCKET).success, true);
  assert.equal(schema.safeParse("/tmp/cloudos.sock").success, false);
});
