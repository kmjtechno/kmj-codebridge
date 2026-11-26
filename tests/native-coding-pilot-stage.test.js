import assert from "node:assert/strict";
import test from "node:test";
import { stageDisabledNativePilot } from "../src/native-coding-pilot-stage.js";

const head = "a".repeat(40);
const scope = { head, ownerApprovedHead: head };
const fixture = () => ({
  gateway: "https://example.invalid/",
  token: "t".repeat(32),
  id: "device1",
  tenant: "tenant1",
  stateDir: "/tmp/codebridge-state",
  license: { mode: "free" },
  projects: [
    {
      id: "kmj-codebridge",
      root: "/tmp/codebridge",
      writable: true,
      gates: { existing: { command: "existing", args: [] } },
      autopilotRepairWorker: {
        enabled: true,
        recipes: {
          existing: {
            fixGate: "existing",
            verifyGate: "existing",
            paths: ["src/"],
          },
        },
      },
    },
    {
      id: "kmj-main-platform",
      root: "/tmp/platform",
      writable: true,
    },
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

test("invalid candidate config fails closed without returning private details", () => {
  const original = fixture();
  original.token = "invalid";
  assert.deepEqual(stageDisabledNativePilot(original, scope), {
    status: "CONFIG_SCHEMA_VALIDATION_FAILED",
  });
  assert.equal(original.projects[0].autopilotCodingWorker, undefined);
  const other = fixture();
  other.projects[1].root = 42;
  assert.deepEqual(stageDisabledNativePilot(other, scope), {
    status: "CONFIG_SCHEMA_VALIDATION_FAILED",
  });
});
