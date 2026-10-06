import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRunner } from "../src/jobs.js";
import { createDispatcher } from "../src/tools.js";

test("Commander job sessions filter and paginate without exposing other projects or outputs", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-job-session-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const runner = new JobRunner(path.join(base, "jobs"));
  t.after(async () => runner.close());
  for (let i = 0; i < 6; i++) {
    const id = "job-" + i;
    runner.jobs.set(id, {
      id,
      project: i === 5 ? "other" : "p1",
      gate: "unit",
      state: i % 2 ? "failed" : "succeeded",
      startedAt: new Date(Date.UTC(2026, 9, 6, 0, i)).toISOString(),
      endedAt: null,
      exitCode: i % 2 ? 1 : 0,
      truncated: false,
      output: "secret=private",
      key: "sensitive-key",
    });
  }
  const first = runner.list("p1", 2);
  assert.equal(first.total, 5);
  assert.deepEqual(first.jobs.map((j) => j.id), ["job-4", "job-3"]);
  assert.equal(first.nextCursor, "job-3");
  const second = runner.list("p1", 2, { cursor: first.nextCursor });
  assert.deepEqual(second.jobs.map((j) => j.id), ["job-2", "job-1"]);
  const last = runner.list("p1", 2, { cursor: second.nextCursor });
  assert.deepEqual(last.jobs.map((j) => j.id), ["job-0"]);
  assert.equal(last.nextCursor, null);
  const failed = runner.list("p1", 10, { state: "failed" });
  assert.deepEqual(failed.jobs.map((j) => j.id), ["job-3", "job-1"]);
  assert.equal(failed.total, 2);
  assert.ok(!JSON.stringify(first).includes("private"));
  assert.ok(!JSON.stringify(first).includes("sensitive-key"));
  assert.ok(!JSON.stringify(first).includes("job-5"));
  assert.throws(() => runner.list("p1", 2, { cursor: "job-5" }), /JOB_CURSOR_NOT_FOUND/);
  assert.throws(() => runner.list("p1", 2, { state: "unknown" }), /INVALID_JOB_STATE/);

  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root: base, writable: false, gates: {}, commands: {} }],
    },
    runner,
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
  );
  const scope = { device: "d1", project: "p1" };
  const response = await dispatch(
    "list_project_jobs",
    { ...scope, limit: 1, state: "succeeded" },
    ["read"],
  );
  assert.equal(response.jobs[0].id, "job-4");
  assert.equal(response.nextCursor, "job-2");
  await assert.rejects(
    dispatch("list_project_jobs", { ...scope, project: "other" }, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
  await assert.rejects(
    dispatch("list_project_jobs", scope, ["write"]),
    /ACCESS_DENIED/,
  );
});
