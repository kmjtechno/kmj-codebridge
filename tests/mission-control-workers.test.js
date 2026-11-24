import test from "node:test";
import assert from "node:assert/strict";
import { buildMissionWorkers } from "../src/mission-control-workers.js";

const scope = { device: "d1", project: "p1" };
const fixture = () => ({
  ok: true,
  value: {
    ...scope,
    evidence: "ACTIVE_AGENT_WORKER_HANDLES",
    processAvailable: true,
    workers: Object.fromEntries(
      ["gate", "repair", "githubCiWatch", "localDraft", "coding"].map((kind) => [
        kind,
        { configured: true, loopStarted: kind === "gate", token: "PRIVATE" },
      ]),
    ),
  },
});

test("worker handle snapshot is scoped and excludes arbitrary metadata", () => {
  const value = buildMissionWorkers({ ...scope, report: fixture() });
  assert.equal(value.status, "AVAILABLE");
  assert.equal(value.items.length, 5);
  assert.equal(value.items.filter((item) => item.loopStarted).length, 1);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|token/);
});

test("foreign, stopped and incomplete worker observations fail closed", () => {
  const foreign = fixture();
  foreign.value.device = "other";
  const stopped = fixture();
  stopped.value.processAvailable = false;
  const incomplete = fixture();
  incomplete.value.workers.coding.loopStarted = null;
  for (const report of [foreign, stopped, incomplete]) {
    assert.equal(
      buildMissionWorkers({ ...scope, report }).status,
      "UNAVAILABLE",
    );
  }
});
