import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher, FAST_READ_TOOLS } from "../src/tools.js";

test("skill_recommendations is read-only, deterministic and fast-batch eligible", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-skill-tool-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({
      features: ["read"],
      limits: { concurrent_jobs: 1 },
    }),
  );

  assert.ok(FAST_READ_TOOLS.includes("skill_recommendations"));
  const result = await dispatch(
    "skill_recommendations",
    {
      device: "d1",
      project: "p1",
      objective: "Fix OAuth authorization regression before release",
      changedFiles: ["src/auth.js"],
      failureSummary: "cross-tenant test failing",
    },
    ["read"],
  );

  assert.deepEqual(
    result.skills.map((skill) => skill.id),
    ["security-hardening", "debugging", "tdd", "release-readiness"],
  );
  assert.ok(result.skills.every((skill) => !("signals" in skill)));
});
