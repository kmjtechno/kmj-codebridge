import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";

const CLOUDOS = "kmj-codebridge-cloudos.service";
const CONFIG = "/home/info/.config/kmj-codebridge/agent.json";
const PROJECT = "/home/info/kmj-cloudos";

function fixture({ state = "active" } = {}) {
  const calls = [];
  const reads = [];
  const restarts = [];
  const handler = createSupervisorHandler({
    profile: "cloudos",
    run: (binary, args) => {
      calls.push({ binary, args });
      if (binary === "/usr/bin/systemctl") {
        assert.equal(args[1], CLOUDOS, "only fixed CloudOS service is touched");
        if (args.includes("--property=LoadState"))
          return "LoadState=loaded\nActiveState=" + state + "\n";
        return "ActiveState=" + state +
          "\nSubState=running\nMainPID=42\nNRestarts=0\n";
      }
      if (binary === "/usr/bin/journalctl")
        return "no credentials in output";
      throw Error("UNAPPROVED_BINARY");
    },
    restart: (unit) => restarts.push(unit),
    readFile: (p) => {
      reads.push(p);
      assert.equal(p, CONFIG);
      return JSON.stringify({
        gateway: "https://kmjtechno.com",
        token: "x".repeat(48),
        id: "google-vps",
        tenant: "tenant1",
        stateDir: "/home/info/.local/state/kmj-codebridge",
        projects: [{ id: "kmj-cloudos", root: PROJECT, writable: true }],
        license: { mode: "free" },
      });
    },
    exists: (p) => p === PROJECT || p === PROJECT + "/.git",
    stat: () => ({ isDirectory: () => true }),
  });
  return { handler, calls, reads, restarts };
}

test("Google supervisor status accepts only fixed CloudOS systemd unit", async () => {
  const f = fixture();
  const result = await f.handler({ op: "status", service: "agent" });
  assert.equal(result.response.activeState, "active");
  assert.equal(result.response.service, "agent");
  assert.equal(f.calls.every((call) => call.args[1] === CLOUDOS), true);
  await assert.rejects(
    f.handler({ op: "status", service: "gateway" }),
    /SUPERVISOR_SERVICE_NOT_ALLOWED/,
  );
  await assert.rejects(
    f.handler({ op: "status", service: "ssh" }),
    /SUPERVISOR_SERVICE_NOT_ALLOWED/,
  );
});

test("Google supervisor only validates pinned rootless CloudOS config", async () => {
  const f = fixture();
  const r = await f.handler({ op: "config_validate", service: "agent" });
  assert.deepEqual(r.response, { service: "agent", valid: true });
  assert.deepEqual(f.reads, [CONFIG]);
});

test("Google supervisor scopes project inspection to CloudOS", async () => {
  const f = fixture();
  assert.deepEqual(
    (await f.handler({ op: "project_status", projectId: "kmj-cloudos" }))
      .response,
    {
      projectId: "kmj-cloudos",
      present: true,
      directory: true,
      gitCheckout: true,
    },
  );
  await assert.rejects(
    f.handler({ op: "project_status", projectId: "kmj-main-platform" }),
    /SUPERVISOR_PROJECT_NOT_AUTHORIZED/,
  );
  assert.deepEqual(f.reads, [CONFIG]);
});

test("Google supervisor allows fixed agent restart only after acknowledgement", async () => {
  const f = fixture();
  const r = await f.handler({ op: "restart", service: "agent" });
  assert.equal(r.response.accepted, true);
  assert.deepEqual(f.restarts, []);
  r.afterSend();
  assert.deepEqual(f.restarts, [CLOUDOS]);
});

test("Google supervisor denies Main Platform and updater privileged RPCs", async () => {
  const f = fixture();
  for (const request of [
    { op: "main_platform_production_activate" },
    { op: "main_platform_refresh" },
    { op: "private_pr322_ci_start" },
    { op: "private_pr419_ci_start" },
    { op: "update_now" },
    { op: "update_rollback" },
    { op: "update_check" },
    { op: "fake", command: "/bin/sh" },
  ]) {
    await assert.rejects(
      f.handler(request),
      /SUPERVISOR_(OPERATION_NOT_ALLOWED|INVALID_SUPERVISOR_REQUEST)/,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("Google supervisor refuses unloaded service and unknown profiles", async () => {
  const f = fixture({ state: "active" });
  const bad = createSupervisorHandler({
    profile: "cloudos",
    run: () => "LoadState=not-found\nActiveState=inactive\n",
  });
  await assert.rejects(
    bad({ op: "status", service: "agent" }),
    /SUPERVISOR_SERVICE_UNAVAILABLE/,
  );
  assert.throws(
    () => createSupervisorHandler({ profile: "untrusted" }),
    /SUPERVISOR_PROFILE_INVALID/,
  );
});
