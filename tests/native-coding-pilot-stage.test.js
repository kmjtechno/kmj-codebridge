import assert from "node:assert/strict";
import test from "node:test";
import { stageDisabledNativePilot } from "../src/native-coding-pilot-stage.js";

const head = "a".repeat(40);
const scope = { head, ownerApprovedHead: head };
const fixture = () => ({
  projects: [
    {
      id: "kmj-codebridge",
      writable: true,
      gates: { existing: { command: "existing", args: [] } },
      autopilotRepairWorker: { enabled: true },
    },
    { id: "kmj-main-platform", writable: true },
  ],
});

test("stage only a disabled candidate without mutating unrelated state", () => {
  const original = fixture();
  const result = stageDisabledNativePilot(original, scope);
  assert.equal(result.status, "DISABLED_CANDIDATE_ONLY");
  assert.equal(result.changed, true);
  assert.deepEqual(original, fixture());
  const project = result.candidate.projects[0];
  assert.equal(project.autopilotCodingWorker.enabled, false);
  assert.equal(
    project.autopilotCodingWorker.cloudSourceTransferApproved,
    false,
  );
  assert.equal(project.gates.native_pilot_check.autopilotCodingSafe, false);
  assert.deepEqual(project.gates.existing, original.projects[0].gates.existing);
  assert.deepEqual(result.candidate.projects[1], original.projects[1]);
  assert.deepEqual(
    project.autopilotRepairWorker,
    original.projects[0].autopilotRepairWorker,
  );
  assert.equal(
    stageDisabledNativePilot(result.candidate, scope).changed,
    false,
  );
});

test("refuse mismatched revisions, ambiguous projects and existing workers", () => {
  const original = fixture();
  assert.equal(
    stageDisabledNativePilot(original, { head }).status,
    "EXACT_SOURCE_SCOPE_REVIEW_REQUIRED",
  );
  original.projects.push({ ...original.projects[0] });
  assert.equal(
    stageDisabledNativePilot(original, scope).status,
    "EXACT_WRITABLE_PROJECT_REQUIRED",
  );
  original.projects.pop();
  original.projects[0].autopilotCodingWorker = { enabled: true };
  assert.deepEqual(stageDisabledNativePilot(original, scope), {
    status: "EXISTING_CODING_CONFIG_REVIEW_REQUIRED",
  });
});

test("refuse a conflicting independent gate", () => {
  const original = fixture();
  original.projects[0].gates.native_pilot_check = { command: "other" };
  assert.deepEqual(stageDisabledNativePilot(original, scope), {
    status: "EXISTING_CODING_CONFIG_REVIEW_REQUIRED",
  });
});
