import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentSchema } from "../src/config.js";
import { createDispatcher } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";

const scope = { device: "d1", project: "p1" };
function fixture(t, requiredFiles = ["vendor/autoload.php"], writable = true) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-readiness-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  const gate = {
    command: process.execPath,
    args: ["-e", "console.log('OK')"],
    requiredFiles,
  };
  const config = agentSchema.parse({
    gateway: "http://127.0.0.1:8787",
    token: "a".repeat(32),
    id: "d1",
    tenant: "t1",
    stateDir: path.join(base, "state"),
    license: { mode: "free" },
    projects: [{ id: "p1", root, writable, gates: { test: gate } }],
  });
  const runner = new JobRunner(path.join(base, "jobs"));
  const dispatch = createDispatcher(config, runner, () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  }));
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { root, base, config, runner, dispatch };
}
test("agent config preserves declared prerequisites", (t) => {
  const { config } = fixture(t);
  assert.deepEqual(config.projects[0].gates.test.requiredFiles, [
    "vendor/autoload.php",
  ]);
});
test("doctor reports missing prerequisites without executing jobs", async (t) => {
  const { dispatch, runner } = fixture(t);
  const d = await dispatch("connection_doctor", scope, ["read"]);
  assert.equal(d.connection, "connected");
  assert.equal(d.gateReadiness.test.status, "blocked");
  assert.deepEqual(d.gateReadiness.test.checks, [
    { path: "vendor/autoload.php", status: "missing", code: "FILE_NOT_FOUND" },
  ]);
  assert.deepEqual(d.effectivePermissions, ["read"]);
  assert.equal(runner.jobs.size, 0);
});
test("missing prerequisite blocks execution before journaling or spawning", async (t) => {
  const { dispatch, runner } = fixture(t);
  await assert.rejects(
    dispatch(
      "run_quality_gate",
      { ...scope, gate: "test", requestKey: "blocked" },
      ["execute"],
    ),
    /GATE_PREREQUISITES_NOT_MET/,
  );
  assert.equal(runner.jobs.size, 0);
  assert.equal(runner.active.size, 0);
});
test("satisfied prerequisites allow execution and replay remains idempotent", async (t) => {
  const { root, dispatch, runner } = fixture(t);
  fs.mkdirSync(path.join(root, "vendor"));
  fs.writeFileSync(path.join(root, "vendor/autoload.php"), "fixture");
  const d = await dispatch("connection_doctor", scope, ["read", "execute"]);
  assert.equal(d.gateReadiness.test.status, "satisfied");
  const args = { ...scope, gate: "test", requestKey: "same" };
  const job = await dispatch("run_quality_gate", args, ["execute"]);
  await runner.active.get(job.id).done;
  assert.equal(runner.get(job.id, "p1").state, "succeeded");
  fs.unlinkSync(path.join(root, "vendor/autoload.php"));
  const replay = await dispatch("run_quality_gate", args, ["execute"]);
  assert.equal(replay.id, job.id);
  assert.equal(runner.jobs.size, 1);
});
test("doctor does not expose restricted prerequisite paths or file contents", async (t) => {
  const { root, dispatch } = fixture(t, [".env"]);
  fs.writeFileSync(path.join(root, ".env"), "PRIVATE_FIXTURE_VALUE");
  const d = await dispatch("connection_doctor", scope, ["read"]);
  assert.equal(d.gateReadiness.test.status, "blocked");
  assert.deepEqual(d.gateReadiness.test.checks, [
    { status: "blocked", code: "PATH_DENIED" },
  ]);
  assert.ok(!JSON.stringify(d).includes("PRIVATE_FIXTURE_VALUE"));
});
test("traversal and symlinks cannot satisfy prerequisites", async (t) => {
  const f = fixture(t, ["../outside.txt"]);
  fs.writeFileSync(path.join(f.base, "outside.txt"), "outside");
  await assert.rejects(
    f.dispatch(
      "run_quality_gate",
      { ...scope, gate: "test", requestKey: "traverse" },
      ["execute"],
    ),
    /GATE_PREREQUISITES_NOT_MET/,
  );
  if (process.platform === "win32") return;
  const g = fixture(t, ["link.txt"]);
  fs.symlinkSync(
    path.join(f.base, "outside.txt"),
    path.join(g.root, "link.txt"),
  );
  const d = await g.dispatch("connection_doctor", scope, ["read"]);
  assert.equal(d.gateReadiness.test.checks[0].code, "SYMLINK_DENIED");
});
test("legacy gates are explicitly unchecked and read-only projects cannot execute", async (t) => {
  const { dispatch } = fixture(t, [], false);
  const d = await dispatch("connection_doctor", scope, [
    "read",
    "write",
    "execute",
  ]);
  assert.equal(d.gateReadiness.test.status, "not_configured");
  assert.deepEqual(d.effectivePermissions, ["read"]);
  await assert.rejects(
    dispatch(
      "run_quality_gate",
      { ...scope, gate: "test", requestKey: "readonly" },
      ["execute"],
    ),
    /READ_ONLY_PROJECT/,
  );
});
test("doctor enforces project and permission boundaries", async (t) => {
  const { dispatch } = fixture(t);
  await assert.rejects(
    dispatch("connection_doctor", { ...scope, project: "other" }, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
  await assert.rejects(
    dispatch("connection_doctor", scope, []),
    /ACCESS_DENIED/,
  );
});
