import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createDispatcher,
  selectVerificationPlan,
} from "../src/tools.js";

test("smart verification selects targeted gates for source changes", () => {
  const plan = selectVerificationPlan({
    changedPaths: ["src/app.ts", "tests/app.test.ts"],
    gates: ["build", "e2e", "lint", "unit", "typecheck"],
    environment: { stacks: ["node"], frameworks: ["react"] },
  });

  assert.equal(plan.mode, "targeted");
  assert.deepEqual(plan.recommendedGates, [
    "lint",
    "typecheck",
    "unit",
    "e2e",
  ]);
  assert.deepEqual(plan.fullGates, [
    "build",
    "e2e",
    "lint",
    "typecheck",
    "unit",
  ]);
  assert.equal(plan.requireFullBeforeRelease, true);
  assert.deepEqual(plan.reasonCodes, ["SOURCE_CHANGE", "TEST_CHANGE"]);
  assert.deepEqual(plan.stacks, ["node"]);
  assert.deepEqual(plan.frameworks, ["react"]);
});

test("smart verification escalates config, CI and unknown scope to all gates", () => {
  const gates = ["build", "lint", "unit"];
  const config = selectVerificationPlan({
    changedPaths: ["package-lock.json"],
    gates,
  });
  assert.equal(config.mode, "full");
  assert.deepEqual(config.recommendedGates, gates);
  assert.deepEqual(config.reasonCodes, ["CONFIG_OR_DEPENDENCY_CHANGE"]);

  const ci = selectVerificationPlan({
    changedPaths: [".github/workflows/ci.yml"],
    gates,
  });
  assert.equal(ci.mode, "full");
  assert.deepEqual(ci.recommendedGates, gates);
  assert.deepEqual(ci.reasonCodes, ["CI_CHANGE"]);

  const unknown = selectVerificationPlan({
    changedPaths: [],
    gates,
    gitAvailable: false,
  });
  assert.equal(unknown.mode, "full");
  assert.deepEqual(unknown.recommendedGates, gates);
  assert.deepEqual(unknown.reasonCodes, ["CHANGE_SCOPE_UNKNOWN"]);
});

test("smart verification reports no configured gates without inventing commands", () => {
  const plan = selectVerificationPlan({
    changedPaths: ["src/app.js"],
    gates: [],
  });
  assert.equal(plan.mode, "unavailable");
  assert.deepEqual(plan.recommendedGates, []);
  assert.deepEqual(plan.fullGates, []);
  assert.deepEqual(plan.reasonCodes, ["NO_CONFIGURED_GATES"]);
});

test("verification plan reads bounded Git change classes without exposing paths", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-verification-plan-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 1;\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { react: "19.0.0" } }),
  );
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "baseline",
    ],
    { cwd: root, stdio: "pipe" },
  );
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");

  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const runner = { maxConcurrent: 1 };
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [
        {
          id: "p1",
          root,
          writable: true,
          gates: {
            build: { command: "unused", args: [], timeoutMs: 1000 },
            lint: { command: "unused", args: [], timeoutMs: 1000 },
            unit: { command: "unused", args: [], timeoutMs: 1000 },
          },
          commands: {},
        },
      ],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 2 },
    }),
  );

  const result = await dispatch(
    "verification_plan",
    { device: "d1", project: "p1" },
    ["read"],
  );

  assert.equal(result.gitAvailable, true);
  assert.equal(result.changesTruncated, false);
  assert.equal(result.mode, "targeted");
  assert.equal(result.changeCount, 1);
  assert.deepEqual(result.changeClasses, {
    source: 1,
    tests: 0,
    docs: 0,
    config: 0,
    ci: 0,
    assets: 0,
    other: 0,
  });
  assert.deepEqual(result.recommendedGates, ["lint", "unit"]);
  assert.deepEqual(result.fullGates, ["build", "lint", "unit"]);
  assert.equal(result.requireFullBeforeRelease, true);
  assert.deepEqual(result.stacks, ["node"]);
  assert.deepEqual(result.frameworks, ["react"]);
  assert.equal(JSON.stringify(result).includes("src/app.js"), false);
});
