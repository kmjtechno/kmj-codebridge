import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProjectProgress } from "../src/project-progress.js";
import { createDispatcher } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";

test("native progress never invents full-project completion when no tasks exist", () => {
  const out = buildProjectProgress({
    sessions: {
      summary: { succeeded: 2, failed: 1 },
      jobs: [],
      archivedJobs: 0,
    },
    autopilotState: {
      counts: {
        queued: 0,
        running: 0,
        waiting: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      },
      next: null,
    },
  });
  assert.equal(out.trackedTasksTotal, 0);
  assert.equal(out.trackedTasksSucceededPercent, null);
  assert.equal(out.wholeProjectCompletionPercent, null);
  assert.equal(out.commercialReleaseReadiness, "NOT_EVALUATED");
  assert.ok(out.attention.includes("NO_TRACKED_TASKS"));
  assert.ok(out.attention.includes("RECENT_OR_HISTORIC_JOB_FAILURES"));
});

test("progress counts persisted tasks but never equates terminal failures with success", () => {
  const out = buildProjectProgress({
    sessions: {
      summary: { succeeded: 3, failed: 2 },
      jobs: [
        {
          id: "job1",
          gate: "test",
          state: "failed",
          output: "token=never-disclose",
          exitCode: 1,
        },
      ],
    },
    autopilotState: {
      counts: {
        queued: 2,
        running: 1,
        waiting: 1,
        succeeded: 5,
        failed: 1,
        cancelled: 0,
      },
      next: { id: "next-task", objective: "secret=never-disclose" },
    },
  });
  assert.equal(out.trackedTasksTotal, 10);
  assert.equal(out.trackedTasksTerminalPercent, 60);
  assert.equal(out.trackedTasksSucceededPercent, 50);
  assert.equal(out.nextReadyTaskId, "next-task");
  assert.ok(out.attention.includes("TASKS_WAITING"));
  assert.ok(out.attention.includes("FAILED_TASKS"));
  assert.ok(!JSON.stringify(out).includes("never-disclose"));
  assert.equal(out.jobs.recent[0].exitCode, 1);
});

test("dispatcher enforces real project and read access for project_progress", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-progress-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "README.md"), "public");
  const runner = new JobRunner(path.join(base, "jobs"));
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  runner.jobs.set("job-1", {
    id: "job-1",
    project: "p1",
    gate: "check",
    state: "succeeded",
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: "2026-10-01T00:00:01.000Z",
    exitCode: 0,
    output: "password=hidden",
  });
  runner.jobs.set("job-2", {
    id: "job-2",
    project: "p2",
    gate: "private",
    state: "failed",
    startedAt: "2026-10-01T00:00:02.000Z",
    endedAt: null,
    exitCode: 1,
    output: "secret=outside",
  });
  const dispatch = createDispatcher(
    {
      id: "device1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    runner,
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
    {
      status: (project) => {
        assert.equal(project, "p1");
        return {
          counts: {
            queued: 1,
            running: 0,
            waiting: 0,
            succeeded: 1,
            failed: 0,
            cancelled: 0,
          },
          next: { id: "task1", objective: "token=masked" },
        };
      },
    },
  );
  const result = await dispatch(
    "project_progress",
    { device: "device1", project: "p1" },
    ["read"],
  );
  assert.equal(result.jobs.counts.succeeded, 1);
  assert.equal(result.jobs.counts.failed, 0);
  assert.equal(result.trackedTasksSucceededPercent, 50);
  assert.ok(!JSON.stringify(result).includes("outside"));
  assert.ok(!JSON.stringify(result).includes("hidden"));
  assert.ok(!JSON.stringify(result).includes("masked"));
  await assert.rejects(
    dispatch("project_progress", { device: "device1", project: "p2" }, [
      "read",
    ]),
    /PROJECT_NOT_FOUND/,
  );
  await assert.rejects(
    dispatch("project_progress", { device: "device1", project: "p1" }, [
      "write",
    ]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch(
      "project_progress",
      { device: "device1", project: "p1", recentJobs: 21 },
      ["read"],
    ),
  );
});
