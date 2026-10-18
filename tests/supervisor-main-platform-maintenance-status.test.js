import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";

const SERVICE_NAMES = [
  "kmj-elite-offsite-backup.service",
  "kmj-elite-health-check.service",
  "kmj-elite-offsite-backup.timer",
  "kmj-elite-health-check.timer",
];

function harness({ failOne = false } = {}) {
  const calls = [];
  const started = [];
  const handle = createSupervisorHandler({
    run: (exe, args) => {
      calls.push({ exe, args });
      assert.equal(exe, "/usr/bin/systemctl");
      assert.equal(args[0], "show");
      assert.ok(SERVICE_NAMES.includes(args[1]));
      assert.equal(args.at(-1), "--no-pager");
      if (failOne && args[1] === SERVICE_NAMES[0]) {
        throw Error("unavailable");
      }
      const result = args[1] === SERVICE_NAMES[0] ? "exit-code" : "success";
      return [
        "LoadState=loaded",
        "ActiveState=inactive",
        "SubState=dead",
        "Result=" + result,
        "ExecMainStatus=" + (result === "success" ? 0 : 255),
        "ExecMainExitTimestamp=Sun 2026-10-18 09:00:00 UTC",
      ].join("\n");
    },
    start: (unit) => started.push(unit),
    restart: (unit) => started.push(unit),
  });
  return { handle, calls, started };
}

test("pinned production maintenance inventory is read-only, categorical and not release approval", async () => {
  const { handle, calls, started } = harness();
  const { response } = await handle({ op: "main_platform_maintenance_status" });
  assert.equal(response.mode, "READ_ONLY");
  assert.equal(response.scope, "kmj-main-platform");
  assert.deepEqual(Object.keys(response.services), [
    "offsiteBackup",
    "healthCheck",
    "offsiteBackupTimer",
    "healthCheckTimer",
  ]);
  assert.equal(response.services.offsiteBackup.result, "exit-code");
  assert.equal(response.services.offsiteBackup.execMainStatus, "255");
  assert.equal(response.services.healthCheck.result, "success");
  assert.equal(response.recentBackupVerified, false);
  assert.equal(response.restoreVerified, false);
  assert.equal(response.productionReleaseApprovedByThisCheck, false);
  assert.equal(calls.length, 4);
  assert.deepEqual(started, []);
  assert.doesNotMatch(
    JSON.stringify(response),
    /\/etc\/|\/root\/|\.env|privateKey|PASSWORD|token/i,
  );
});

test("maintenance status rejects caller-supplied shell, path, unit, variants or approval", async () => {
  const { handle, calls, started } = harness();
  for (const injection of [
    { command: "/bin/sh" },
    { path: "/root/.ssh" },
    { unit: "nginx.service" },
    { service: "ssh" },
    { args: ["restart"] },
    { confirmation: "ACTIVATE_APPROVED_PRODUCTION_RELEASE" },
  ]) {
    await assert.rejects(
      handle({ op: "main_platform_maintenance_status", ...injection }),
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(started, []);
});

test("unknown one-shot service is reported not installed, never promoted to healthy", async () => {
  const { handle, started } = harness({ failOne: true });
  const { response } = await handle({ op: "main_platform_maintenance_status" });
  assert.equal(response.services.offsiteBackup.installed, false);
  assert.equal(response.services.offsiteBackup.result, "unknown");
  assert.equal(response.productionReleaseApprovedByThisCheck, false);
  assert.deepEqual(started, []);
});
