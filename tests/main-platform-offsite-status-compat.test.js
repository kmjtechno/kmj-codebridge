import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";

const DEVICE = "kmj-elite-main-platform";
const PROJECT = "kmj-main-platform";

function fixture(
  t,
  {
    device = DEVICE,
    project = PROJECT,
    writable = true,
    supervisor = true,
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-offsite-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  const calls = [];
  const runner = {
    maxConcurrent: 1,
    run: () => {
      throw Error("Read-only inventory must never run a job");
    },
  };
  const mockSupervisor = supervisor
    ? {
        request: async (request) => {
          calls.push(request);
          return {
            response: {
              mode: "READ_ONLY",
              services: {
                offsiteBackup: {
                  installed: true,
                  activeState: "inactive",
                  result: "success",
                  execMainStatus: "0",
                  secretToken: "never-disclose",
                },
                offsiteBackupTimer: {
                  installed: true,
                  activeState: "active",
                  result: "success",
                  execMainStatus: "0",
                },
                healthCheck: {
                  installed: true,
                  activeState: "inactive",
                  result: "success",
                  execMainStatus: "0",
                },
              },
              privateKey: "never-disclose",
              recentBackupVerified: true,
              restoreVerified: true,
              productionReleaseApprovedByThisCheck: true,
            },
          };
        },
      }
    : null;
  const dispatch = createDispatcher(
    {
      id: device,
      stateDir,
      projects: [{ id: project, root, writable, gates: {}, commands: {} }],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
    null,
    mockSupervisor,
  );
  const input = (extra = {}) => ({
    device,
    project,
    command: "main_platform_offsite_status",
    variant: "overview",
    requestKey: "offsite-20261020",
    ...extra,
  });
  return { dispatch, input, calls };
}

test("existing client lists fixed read-only offsite status on authorized production device", async (t) => {
  const f = fixture(t);
  const commands = await f.dispatch(
    "list_project_commands",
    { device: DEVICE, project: PROJECT },
    ["read"],
  );
  const profile = commands.commands.find(
    (cmd) => cmd.id === "main_platform_offsite_status",
  );
  assert.ok(profile);
  assert.deepEqual(profile.variants, ["overview"]);
  assert.equal(profile.category, "inspect");
  assert.equal(profile.risk, "READ");
  assert.equal(profile.approvalRequired, false);

  const response = await f.dispatch("run_project_command", f.input(), [
    "execute",
  ]);
  assert.deepEqual(f.calls, [{ op: "main_platform_maintenance_status" }]);
  assert.equal(response.mode, "READ_ONLY");
  assert.equal(response.backupTimer.activeState, "active");
  assert.equal(response.backupService.result, "success");
  assert.equal(response.healthCheck.installed, true);
  assert.equal(response.candidateEncryptedOffsiteVerified, false);
  assert.equal(response.independentRestoreVerified, false);
  assert.equal(response.rollbackVerified, false);
  assert.equal(response.productionApprovalChanged, false);
  assert.doesNotMatch(
    JSON.stringify(response),
    /never-disclose|privateKey|secretToken|remoteName|\/root\/|\.env/,
  );
});

test("offsite compatibility inventory rejects execution overrides and requires execute capability", async (t) => {
  const f = fixture(t);
  for (const changes of [
    { variant: "start" },
    { variant: "upload" },
    { variant: "restore" },
    { laneId: "other" },
    { expectedHead: "a".repeat(40) },
    { command: "/bin/sh" },
    { destination: "attacker:remote" },
  ]) {
    await assert.rejects(
      f.dispatch("run_project_command", f.input(changes), ["execute"]),
    );
  }
  await assert.rejects(
    f.dispatch("run_project_command", f.input(), ["read"]),
    /ACCESS_DENIED/,
  );
  assert.deepEqual(f.calls, []);
});

test("offsite compatibility status fails closed on wrong device, project, or missing supervisor", async (t) => {
  for (const config of [
    { device: "not-kmj-elite", project: PROJECT },
    { device: DEVICE, project: "other-project" },
    { device: DEVICE, project: PROJECT, writable: false },
    { device: DEVICE, project: PROJECT, supervisor: false },
  ]) {
    const f = fixture(t, config);
    const listing = await f.dispatch(
      "list_project_commands",
      { device: config.device, project: config.project },
      ["read"],
    );
    assert.equal(
      listing.commands.some((cmd) => cmd.id === "main_platform_offsite_status"),
      false,
    );
    await assert.rejects(
      f.dispatch("run_project_command", f.input(), ["execute"]),
      /MAIN_PLATFORM_OFFSITE_STATUS_NOT_AUTHORIZED|SUPERVISOR_UNAVAILABLE/,
    );
    assert.deepEqual(f.calls, []);
  }
});

test("unknown or injected supervisor telemetry never becomes a backup approval", async (t) => {
  const f = fixture(t);
  const response = await f.dispatch(
    "run_project_command",
    f.input({ requestKey: "invalid-telemetry-v1" }),
    ["execute"],
  );
  assert.equal(response.candidateEncryptedOffsiteVerified, false);
  assert.equal(response.independentRestoreVerified, false);
  assert.equal(response.productionApprovalChanged, false);
  assert.equal(Object.hasOwn(response, "privateKey"), false);
});
