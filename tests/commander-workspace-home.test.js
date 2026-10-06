import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";
import { JobRunner } from "../src/jobs.js";

test("one-click workspace includes only the authorized file tree, environment and sessions", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-workspace-home-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, ".ssh"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      dependencies: { react: "19.0.0" },
      devDependencies: { vite: "8.0.0" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "src", "main.ts"),
    "export const value = 1;",
  );
  fs.writeFileSync(path.join(root, ".env"), "token=hidden");
  fs.writeFileSync(path.join(root, ".ssh", "private"), "hidden");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const runner = new JobRunner(path.join(base, "jobs"));
  t.after(async () => runner.close());
  runner.jobs.set("public-job", {
    id: "public-job",
    project: "p1",
    gate: "test",
    state: "succeeded",
    startedAt: "2026-10-06T09:00:00.000Z",
    endedAt: "2026-10-06T09:00:01.000Z",
    exitCode: 0,
    output: "secret=hidden",
    truncated: false,
  });
  runner.jobs.set("private-job", {
    id: "private-job",
    project: "p2",
    gate: "private",
    state: "failed",
    startedAt: "2026-10-06T09:30:00.000Z",
    endedAt: null,
    exitCode: 1,
    output: "other-customer-secret",
    truncated: false,
  });
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [
        {
          id: "p1",
          root,
          writable: false,
          gates: { unit: { command: "node", args: [], timeoutMs: 1000 } },
          commands: {},
        },
      ],
    },
    runner,
    () => ({
      features: ["read"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  const scope = { device: "d1", project: "p1" };
  const home = await dispatch("workspace_home", scope, ["read"]);
  assert.equal(home.device, "d1");
  assert.equal(home.project, "p1");
  assert.equal(home.writable, false);
  assert.deepEqual(home.environment.stacks, ["node"]);
  assert.deepEqual(home.environment.frameworks, ["react", "vite"]);
  assert.deepEqual(home.qualityGates, ["unit"]);
  assert.deepEqual(
    home.sessions.jobs.map((job) => job.id),
    ["public-job"],
  );
  assert.ok(
    home.explorer.entries.some((entry) => entry.path === "src/main.ts"),
  );
  assert.equal(home.nextActions.browse, "project_tree");
  assert.equal(home.nextActions.safeFolderCreation, "create_project_directory");
  assert.equal(home.nextActions.safeFileCopy, "copy_project_file");
  assert.ok(!JSON.stringify(home).includes("other-customer-secret"));
  assert.ok(!JSON.stringify(home).includes("token=hidden"));
  assert.ok(!JSON.stringify(home).includes(".ssh"));
  assert.ok(!JSON.stringify(home).includes(".env"));

  await assert.rejects(
    dispatch("workspace_home", { ...scope, project: "p2" }, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
  await assert.rejects(
    dispatch("workspace_home", scope, ["write"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("workspace_home", { ...scope, maxEntries: 999 }, ["read"]),
    /100|too_big/,
  );
});
