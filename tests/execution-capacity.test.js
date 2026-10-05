import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";

test("execution capacity exposes bounded scheduler state for the authorized project", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-capacity-tool-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const calls = [];
  const runner = {
    maxConcurrent: 1,
    capacity(cwd) {
      calls.push(cwd);
      return {
        blocked: false,
        blockReason: null,
        constrained: true,
        configuredMaxConcurrent: 4,
        effectiveMaxConcurrent: 1,
        activeJobs: 1,
        cpuCount: 8,
        loadOne: 16,
        loadPerCpu: 2,
        totalMemoryBytes: 16 * 1024 ** 3,
        freeMemoryBytes: 4 * 1024 ** 3,
        memoryFreeRatio: 0.25,
        freeDiskBytes: 50 * 1024 ** 3,
        thresholds: {
          minFreeMemoryBytes: 128 * 1024 ** 2,
          minFreeDiskBytes: 512 * 1024 ** 2,
          constrainedMemoryFreeRatio: 0.1,
          constrainedLoadPerCpu: 1.5,
        },
      };
    },
  };

  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: true, gates: {}, commands: {} }],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 4 },
    }),
  );

  const result = await dispatch(
    "execution_capacity",
    { device: "d1", project: "p1" },
    ["read"],
  );

  assert.deepEqual(calls, [root]);
  assert.equal(result.device, "d1");
  assert.equal(result.project, "p1");
  assert.equal(result.constrained, true);
  assert.equal(result.effectiveMaxConcurrent, 1);
  assert.equal(result.blocked, false);
  assert.equal(runner.maxConcurrent, 4);
});
