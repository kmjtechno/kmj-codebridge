import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRunner } from "../src/jobs.js";
import { AutopilotJournal } from "../src/autopilot.js";
import { createDispatcher, definitions } from "../src/tools.js";

function fixture(t, localModelFactory) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-offline-draft-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  const runner = new JobRunner(path.join(base, "jobs"));
  t.after(async () => runner.close());
  const autopilot = new AutopilotJournal(path.join(base, "autopilot"));
  const dispatch = createDispatcher({
    id: "device1", stateDir: path.join(base, "state"),
    projects: [{ id: "project1", root, writable: true, gates: {}, commands: {} }],
  }, runner, () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  }), autopilot, null, null, localModelFactory);
  return { dispatch, autopilot, base, root, scope: { device: "device1", project: "project1" } };
}

test("explicit owner approval is required; draft checkpoints avoid repeated local inference", async (t) => {
  let calls = 0;
  const localFactory = () => ({
    async generate({ model, prompt }) {
      calls += 1;
      assert.equal(model, "tiny:1b");
      assert.match(prompt, /Feature A/);
      assert.doesNotMatch(prompt, /secret-password/);
      return { response: "Implement local unit test. Bearer sampleTokenValue123" };
    },
  });
  const { dispatch, autopilot, scope, root } = fixture(t, localFactory);
  const queued = autopilot.enqueue({
    project: "project1", key: "feature-a", objective: "Feature A",
  });
  assert.equal(autopilot.claim("project1").id, queued.id);
  assert.equal(definitions.autopilot_local_draft.access, "execute");
  const payload = { ...scope, task: queued.id, model: "tiny:1b" };
  await assert.rejects(
    dispatch("autopilot_local_draft", payload, ["execute"]),
    /invalid_type|invalid_literal|Invalid literal value/i,
  );
  await assert.rejects(
    dispatch("autopilot_local_draft", { ...payload, localProcessingApproved: true }, ["read"]),
    /ACCESS_DENIED/,
  );
  const out = await dispatch("autopilot_local_draft", {
    ...payload, localProcessingApproved: true,
  }, ["execute"]);
  assert.equal(out.writesApplied, false);
  assert.equal(out.reviewRequired, true);
  assert.equal(out.paidInference, false);
  assert.match(out.proposal, /\[REDACTED\]/);
  assert.doesNotMatch(out.proposal, /sampleTokenValue123/);
  assert.equal(calls, 1);
  assert.equal(fs.readdirSync(root).length, 0);
  const replay = await dispatch("autopilot_local_draft", {
    ...payload, localProcessingApproved: true,
  }, ["execute"]);
  assert.equal(replay.reused, true);
  assert.equal(calls, 1);
  assert.equal(autopilot.get(queued.id, "project1").state, "running");
  assert.equal(autopilot.get(queued.id, "project1").checkpoint.next, "LOCAL_DRAFT_AWAITING_REVIEW");
});

test("unavailable local inference never checkpoints, edits files or charges a cloud API", async (t) => {
  const { dispatch, autopilot, scope } = fixture(t, () => ({
    async generate() { throw new Error("LOCAL_MODEL_NOT_RUNNING"); },
  }));
  const queued = autopilot.enqueue({ project: "project1", key: "x", objective: "Test only" });
  autopilot.claim("project1");
  await assert.rejects(
    dispatch("autopilot_local_draft", {
      ...scope, task: queued.id, model: "tiny:1b", localProcessingApproved: true,
    }, ["execute"]),
    /LOCAL_MODEL_NOT_RUNNING/,
  );
  assert.equal(autopilot.get(queued.id, "project1").checkpoint, null);
});

test("finished, unclaimed or pre-checkpointed tasks never run a second model", async (t) => {
  let count = 0;
  const { dispatch, autopilot, scope } = fixture(t, () => ({
    async generate() { count += 1; return { response: "should not run" }; },
  }));
  const queued = autopilot.enqueue({ project: "project1", key: "b", objective: "Safe task" });
  const payload = { ...scope, task: queued.id, model: "tiny:1b", localProcessingApproved: true };
  await assert.rejects(dispatch("autopilot_local_draft", payload, ["execute"]), /AUTOPILOT_TASK_NOT_RUNNING/);
  autopilot.claim("project1");
  autopilot.checkpoint(queued.id, "project1", { summary: "Owner checkpoint", next: "Review" });
  await assert.rejects(dispatch("autopilot_local_draft", payload, ["execute"]), /AUTOPILOT_CHECKPOINT_EXISTS/);
  assert.equal(count, 0);
});
