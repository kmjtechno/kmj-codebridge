import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSupervisorHandler } from "../src/supervisor.js";
import { createDispatcher } from "../src/tools.js";

const DEVICE = "kmj-elite-main-platform";
const PROJECT = "kmj-main-platform";
function evidence() {
  return {
    mode: "READ_ONLY",
    daily: { state: "PRESENT", stamp: "20261115T050000Z", fresh: true, bytes: 104 },
    vault: { state: "PRESENT", stamp: "20261115T050000Z", fresh: true, bytes: 128 },
    localHealthArtifactsFresh: true,
    remoteShaReadbackVerified: false,
    independentRestoreVerified: false,
    productionReleaseApproved: false,
  };
}
test("root Supervisor fixed backup evidence needs no shell and rejects caller parameters", async () => {
  const units = [];
  const handle = createSupervisorHandler({
    backupEvidence: evidence,
    start: (unit) => units.push(unit),
    restart: (unit) => units.push(unit),
    run: () => { throw Error("unexpected process execution"); },
  });
  const result = await handle({ op: "main_platform_local_backup_evidence" });
  assert.equal(result.response.localHealthArtifactsFresh, true);
  assert.deepEqual(units, []);
  for (const override of [
    { path: "/root/.ssh" }, { command: "bash" }, { args: ["--repair"] },
    { unit: "nginx.service" }, { confirmation: "APPLY" }, { target: "../etc" },
  ]) {
    await assert.rejects(handle({ op: "main_platform_local_backup_evidence", ...override }));
  }
});
function fixture(t, { device = DEVICE, project = PROJECT, writable = true, supervisor = true } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-seq26-tools-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const root = path.join(work, "project"), stateDir = path.join(work, "state");
  fs.mkdirSync(root);fs.mkdirSync(stateDir);
  const calls = [];
  const provider = supervisor ? { request: async (request) => {
    calls.push(request);
    return { response: { ...evidence(), privateKey: "redacted-never", daily: {
      ...evidence().daily, secretToken: "never" } } };
  }} : null;
  const dispatcher = createDispatcher(
    { id: device, stateDir, projects: [{ id: project, root, writable, gates: {}, commands: {} }] },
    { maxConcurrent: 1, run: () => { throw Error("must not start jobs"); } },
    () => ({ features: ["read", "write", "execute"], limits: { concurrent_jobs: 1 } }),
    null, provider,
  );
  return { dispatcher, calls, device, project };
}
test("direct MCP read-only tool and existing-client command use identical fixed supervisor op", async (t) => {
  const f = fixture(t);
  const direct = await f.dispatcher(
    "supervisor_main_platform_local_backup_evidence", { device: DEVICE, project: PROJECT }, ["read"]
  );
  assert.equal(direct.response.localHealthArtifactsFresh, true);
  const list = await f.dispatcher("list_project_commands", { device: DEVICE, project: PROJECT }, ["read"]);
  const command = list.commands.find((row) => row.id === "main_platform_local_backup_evidence");
  assert.deepEqual(command?.variants, ["overview"]);
  assert.equal(command?.approvalRequired, false);
  const oldClient = await f.dispatcher("run_project_command", {
    device: DEVICE, project: PROJECT, command: "main_platform_local_backup_evidence",
    variant: "overview", requestKey: "seq26-fixture-1",
  }, ["execute"]);
  assert.equal(oldClient.mode, "READ_ONLY");
  assert.equal(oldClient.localHealthArtifactsFresh, true);
  assert.equal(oldClient.remoteShaReadbackVerified, false);
  assert.equal(oldClient.independentRestoreVerified, false);
  assert.equal(Object.hasOwn(oldClient, "privateKey"), false);
  assert.equal(Object.hasOwn(oldClient.daily, "secretToken"), false);
  assert.deepEqual(f.calls, [
    { op: "main_platform_local_backup_evidence" },
    { op: "main_platform_local_backup_evidence" },
  ]);
});
test("client cannot smuggle shell/path/unknown variants through old command", async (t) => {
  const f = fixture(t);
  for (const overrides of [
    { variant: "apply" }, { variant: "prune" },
    { laneId: "private" }, { expectedHead: "a".repeat(40) },
    { path: "/root/secret" }, { extra: "extra" },
  ]) {
    await assert.rejects(f.dispatcher("run_project_command", {
      device: DEVICE, project: PROJECT, command: "main_platform_local_backup_evidence",
      variant: "overview", requestKey: "seq26-invalid-1", ...overrides,
    }, ["execute"]));
  }
  assert.deepEqual(f.calls, []);
});
test("wrong device/project, disabled write grant or absent Supervisor never exposes privileged inspection", async(t) => {
  for (const variant of [
    { device: "other", project: PROJECT }, { device: DEVICE, project: "other" },
    { device: DEVICE, project: PROJECT, writable: false },
    { device: DEVICE, project: PROJECT, supervisor: false },
  ]) {
    const f = fixture(t, variant);
    const names = await f.dispatcher("list_project_commands", {
      device: f.device, project: f.project,
    }, ["read"]);
    assert.equal(names.commands.some(x => x.id === "main_platform_local_backup_evidence"), false);
    await assert.rejects(f.dispatcher("run_project_command", {
      device: f.device, project: f.project, command: "main_platform_local_backup_evidence",
      variant: "overview", requestKey: "seq26-blocked-1",
    }, ["execute"]));
    assert.deepEqual(f.calls, []);
  }
});
