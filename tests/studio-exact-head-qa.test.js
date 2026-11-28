import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planStudioQa,
  classifyStudioTestInventory,
  validateStudioLane,
} from "../scripts/studio-exact-head-qa.mjs";

test("exact Studio Qt plan is bounded and never targets the shared root", () => {
  const stages = planStudioQa({
    cmake: "cmake",
    ctest: "ctest",
    qt: "Qt",
    build: "lane-build",
  });
  assert.deepEqual(
    stages.map((stage) => stage.name),
    ["configure", "build", "ctest"],
  );
  assert.deepEqual(stages[0].args.slice(0, 4), ["-S", ".", "-B", "lane-build"]);
  assert.ok(stages[2].args.includes("--no-tests=error"));
  assert.ok(
    stages[2].args.includes(
      "^(desktop-smoke|independent-engine|media-control|measured-fisheye|measured-surface)$",
    ),
  );
});

test("exact Studio QA refuses shared checkouts and preexisting build output", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-exact-qa-"));
  try {
    const state = path.join(temp, "state");
    const lane = path.join(
      state,
      "isolated-worktrees",
      "kmj-calibration-studio",
      "exact-fixture",
    );
    fs.mkdirSync(lane, { recursive: true });
    fs.writeFileSync(path.join(lane, ".git"), "gitdir: fixture");
    fs.writeFileSync(path.join(lane, "CMakeLists.txt"), "fixture");
    const result = validateStudioLane({ cwd: lane, state });
    assert.equal(result.cwd, fs.realpathSync(lane));
    assert.throws(
      () => validateStudioLane({ cwd: temp, state }),
      /STUDIO_QA_EXACT_LANE_REQUIRED/,
    );
    fs.mkdirSync(result.build);
    assert.throws(
      () => validateStudioLane({ cwd: lane, state }),
      /STUDIO_QA_BUILD_EXISTS/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Studio exact QA distinguishes legacy and measured offline coverage", () => {
  const core = ["desktop-smoke", "independent-engine", "media-control"];
  const inventory = (names) => ({ tests: names.map((name) => ({ name })) });
  assert.equal(classifyStudioTestInventory(inventory(core)), "NOT_REGISTERED");
  assert.equal(
    classifyStudioTestInventory(
      inventory([...core, "measured-fisheye", "measured-surface"]),
    ),
    "REGISTERED",
  );
  for (const names of [
    [...core, "measured-fisheye"],
    [...core, "measured-surface"],
    [...core, "hardware-scan"],
    [...core, "desktop-smoke"],
    core.slice(1),
  ]) {
    assert.throws(
      () => classifyStudioTestInventory(inventory(names)),
      /STUDIO_QA_TEST_INVENTORY_REJECTED/,
    );
  }
  assert.throws(
    () => classifyStudioTestInventory({ tests: [{ name: null }] }),
    /STUDIO_QA_TEST_INVENTORY_REJECTED/,
  );
});
