import assert from "node:assert/strict";
import test from "node:test";
import { planNativeCodingPilot } from "../src/native-coding-pilot-plan.js";

const HEAD = "a".repeat(40);

test("native pilot requires an exact reviewed source revision", () => {
  for (const input of [
    undefined,
    {},
    { head: HEAD },
    { head: HEAD, ownerApprovedHead: "b".repeat(40) },
    { head: "main", ownerApprovedHead: "main" },
    { head: HEAD + "\n", ownerApprovedHead: HEAD + "\n" },
  ]) {
    assert.deepEqual(planNativeCodingPilot(input), {
      status: "EXACT_SOURCE_SCOPE_REVIEW_REQUIRED",
    });
  }
});

test("pilot proposal never grants inference, execution or source consent", () => {
  const plan = planNativeCodingPilot({
    head: HEAD,
    ownerApprovedHead: HEAD,
  });
  assert.equal(plan.status, "PROPOSAL_ONLY_NOT_ACTIVATED");
  assert.equal(plan.worker.enabled, false);
  assert.equal(plan.worker.nativeModelFabricApproved, false);
  assert.equal(plan.worker.cloudSourceTransferApproved, false);
  assert.equal(plan.worker.cloudProxyApproved, false);
  assert.equal(plan.worker.localProcessingApproved, false);
  assert.equal(plan.gate.autopilotCodingSafe, false);
  assert.equal(plan.worker.inferenceRoute, "native-verified-free-cloud-only");
  assert.equal(plan.taskKey, "auto-code:pilot:" + HEAD);
});

test("the independent test is outside the only editable and transferable file", () => {
  const plan = planNativeCodingPilot({
    head: HEAD,
    ownerApprovedHead: HEAD,
  });
  const recipe = plan.worker.recipes.pilot;
  assert.deepEqual(recipe.paths, ["src/skill-packs.js"]);
  assert.deepEqual(recipe.contextPaths, recipe.paths);
  assert.deepEqual(plan.gate.args, ["--test", "tests/skill-packs.test.js"]);
  assert.ok(!recipe.paths.includes(plan.gate.args[1]));
  assert.equal(recipe.verifyGate, plan.gateName);
  assert.ok(
    plan.requiredBeforeActivation.includes(
      "LIVE_STRICT_FREE_ACCOUNT_AND_QUOTA",
    ),
  );
});
