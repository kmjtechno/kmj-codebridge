import test from "node:test";
import assert from "node:assert/strict";
import { buildMissionActivity } from "../src/mission-control-activity.js";

const now = Date.parse("2026-10-16T02:00:00.000Z");
const receipts = () => ({
  ok: true,
  value: {
    project: "project1",
    total: 2,
    nextCursor: null,
    jobs: [
      {
        id: "7d2a4fc1-22d3",
        gate: "check",
        state: "succeeded",
        queuedAt: "2026-10-16T01:59:00.000Z",
        startedAt: "2026-10-16T01:59:10.000Z",
        endedAt: "2026-10-16T01:59:25.000Z",
        exitCode: 0,
        output: "SECRET_NEVER_RETURN",
        args: ["SENSITIVE"],
        privateToken: "PRIVATE_VALUE",
      },
      {
        id: "a2b3c4",
        gate: "test",
        state: "running",
        queuedAt: "2026-10-16T01:59:45.000Z",
        startedAt: "2026-10-16T01:59:50.000Z",
      },
    ],
  },
});

test("activity only includes bounded server-approved receipt fields", () => {
  const activity = buildMissionActivity({
    project: "project1",
    jobs: receipts(),
    now,
  });
  assert.equal(activity.status, "AVAILABLE");
  assert.equal(activity.items.length, 2);
  assert.deepEqual(activity.items[0], {
    id: "7d2a4fc1-22d3",
    gate: "check",
    state: "succeeded",
    at: "2026-10-16T01:59:25.000Z",
    exitCode: 0,
  });
  assert.equal(activity.items[1].state, "running");
  assert.equal(activity.hasMore, false);
  assert.equal(activity.observedAt, "2026-10-16T02:00:00.000Z");
  assert.doesNotMatch(
    JSON.stringify(activity),
    /SECRET_NEVER_RETURN|SENSITIVE|privateToken|PRIVATE_VALUE/,
  );
});

test("cross-project receipts and failures never display fabricated activity", () => {
  const input = receipts();
  input.value.project = "foreign-project";
  const wrong = buildMissionActivity({ project: "project1", jobs: input, now });
  assert.equal(wrong.status, "UNAVAILABLE");
  assert.deepEqual(wrong.items, []);
  assert.equal(wrong.observedAt, null);

  for (const response of [
    { ok: false, error: "DEVICE_TIMEOUT" },
    { ok: true, value: { project: "project1", jobs: [], total: null } },
    { ok: true, value: { project: "project1", jobs: "foo", total: 0 } },
  ]) {
    assert.equal(
      buildMissionActivity({ project: "project1", jobs: response, now }).status,
      "UNAVAILABLE",
    );
  }
});

test("malformed/secret-like gate names, invalid states and future timestamps fail closed", () => {
  const cases = [
    (job) => (job.gate = "secret=api-key"),
    (job) => (job.state = "invented_pass"),
    (job) => (job.endedAt = "2030-10-16T01:59:25Z"),
    (job) => (job.id = "../other-tenant"),
  ];
  for (const mutate of cases) {
    const response = receipts();
    mutate(response.value.jobs[0]);
    const activity = buildMissionActivity({
      project: "project1",
      jobs: response,
      now,
    });
    assert.equal(activity.status, "UNAVAILABLE");
    assert.deepEqual(activity.items, []);
  }
});

test("pagination is labelled, not quietly presented as a complete history", () => {
  const input = receipts();
  input.value.total = 10;
  input.value.nextCursor = "a2b3c4";
  const result = buildMissionActivity({
    project: "project1",
    jobs: input,
    now,
  });
  assert.equal(result.hasMore, true);
  assert.equal(result.items.length, 2);
});

test("bounded receipt count prevents unbounded payloads", () => {
  const input = receipts();
  input.value.jobs = Array.from({ length: 7 }, () => input.value.jobs[0]);
  input.value.total = 7;
  assert.equal(
    buildMissionActivity({ project: "project1", jobs: input, now }).status,
    "UNAVAILABLE",
  );
});
