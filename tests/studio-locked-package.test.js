import test from "node:test";
import assert from "node:assert/strict";
import { planStudioPackaging } from "../scripts/studio-locked-package.mjs";
import { commandRequiresIsolatedLane } from "../src/command-presets.js";

test("Studio packaging runs exact-head acceptance before candidate creation", () => {
  const sha = "a".repeat(40);
  const plan = planStudioPackaging({
    powershell: "powershell",
    qt: "Qt",
    sha,
  });
  assert.deepEqual(
    plan.map((stage) => stage.name),
    ["acceptance", "candidate"],
  );
  assert.deepEqual(plan[0].args, [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    "scripts/verify_locked_release.ps1",
    "-ExpectedSha",
    sha,
    "-QtRoot",
    "Qt",
    "-Generator",
    "Visual Studio 18 2026",
  ]);
  assert.deepEqual(plan[1].args, [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    "scripts/package_windows_release.ps1",
    "-ExpectedSha",
    sha,
  ]);
  assert.equal(commandRequiresIsolatedLane("calibration_studio_package"), true);
  for (const stage of plan)
    assert.equal(stage.args.includes("-ExecutionPolicy"), false);
});

test("Studio packaging rejects unpinned source revisions", () => {
  for (const sha of ["main", "abc123", "../checkout", "a".repeat(41)]) {
    assert.throws(
      () => planStudioPackaging({ powershell: "powershell", qt: "Qt", sha }),
      /STUDIO_PACKAGE_SHA_REQUIRED/,
    );
  }
});
