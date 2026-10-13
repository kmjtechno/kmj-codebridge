import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutopilotJournal } from "../src/autopilot.js";
import {
  LocalAutopilotDraftWorker,
  startLocalAutopilotDraftWorker,
} from "../src/autopilot-local-worker.js";
import { canQueueAutopilotGate } from "../src/autopilot-gate-worker.js";

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-local-draft-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = new AutopilotJournal(dir);
  let calls = 0;
  let statusCalls = 0;
  const model = {
    status: async () => {
      statusCalls++;
      return {
        available: !options.offline,
        activeRequest: false,
        models: options.offline ? [] : ["qwen3:4b"],
      };
    },
    generate: async () => {
      calls++;
      if (options.fail) throw new Error("simulated model outage");
      return {
        response: "Proposed steps: inspect, implement, unit test; untrusted.",
        truncated: false,
        hitTokenLimit: false,
      };
    },
  };
  const project = {
    id: "repo",
    writable: true,
    autopilotLocalWorker: {
      enabled: true,
      model: "qwen3:4b",
      maxTokens: 128,
      timeoutSeconds: 10,
    },
  };
  const worker = new LocalAutopilotDraftWorker({
    projects: [project],
    journal,
    localModel: () => model,
    licenseProvider: () => ({
      features: options.noExecute ? ["read", "write"] : ["execute"],
    }),
  });
  return {
    journal,
    worker,
    project,
    calls: () => calls,
    statusCalls: () => statusCalls,
    enqueue: (key = "auto-draft:feature-a") =>
      journal.enqueue({ project: "repo", key, objective: "Implement task safely" }),
  };
}

test("local draft is saved and paused, never marked implemented", async (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  await f.worker.tick();
  const result = f.journal.get(task.id, "repo");
  assert.equal(result.state, "waiting");
  assert.equal(result.lastReason, "LOCAL_DRAFT_AWAITING_REVIEW");
  assert.equal(result.checkpoint.next, "LOCAL_DRAFT_AWAITING_REVIEW");
  assert.match(result.checkpoint.summary, /Proposed steps/);
  assert.equal(f.calls(), 1);
  await f.worker.tick();
  assert.equal(f.calls(), 1);
});

test("ordinary roadmap work is not taken or falsely finished", async (t) => {
  const f = fixture(t);
  const general = f.enqueue("mission:important-milestone");
  await f.worker.tick();
  assert.equal(f.journal.get(general.id, "repo").state, "queued");
  assert.equal(f.calls(), 0);
});

test("offline local model preserves task in queued state", async (t) => {
  const f = fixture(t, { offline: true });
  const task = f.enqueue();
  await f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "queued");
  assert.equal(f.calls(), 0);
});

test("invalid execute entitlement does not claim or run", async (t) => {
  const f = fixture(t, { noExecute: true });
  const task = f.enqueue();
  await f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "queued");
  assert.equal(f.statusCalls(), 0);
});

test("failed inference leaves a review-required task, not a false success", async (t) => {
  const f = fixture(t, { fail: true });
  const task = f.enqueue();
  await f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "LOCAL_INFERENCE_FAILED_REVIEW_REQUIRED",
  );
  assert.equal(f.calls(), 1);
});

test("resumed checkpoint cannot repeat generation or overwrite proposal", async (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  const claimed = f.journal.claim("repo", {
    holder: "other",
    eligible: (candidate) => candidate.id === task.id,
  });
  f.journal.checkpoint(task.id, "repo", {
    summary: "previous immutable draft",
    next: "LOCAL_DRAFT_AWAITING_REVIEW",
    leaseToken: claimed.leaseToken,
  });
  f.journal.wait(task.id, "repo", "manual", claimed.leaseToken);
  f.journal.resume(task.id, "repo");
  await f.worker.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.journal.get(task.id, "repo").checkpoint.summary, "previous immutable draft");
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
});

test("write-only user cannot queue opt-in unattended inference", () => {
  assert.equal(canQueueAutopilotGate("auto-draft:feature-a", ["write"]), false);
  assert.equal(
    canQueueAutopilotGate("auto-draft:feature-a", ["write", "execute"]),
    true,
  );
  assert.equal(canQueueAutopilotGate("mission:feature-a", ["write"]), true);
});

test("disabled draft worker requires no running loop or installed model", async () => {
  const service = startLocalAutopilotDraftWorker({
    projects: [],
    journal: null,
    licenseProvider: null,
    localModel: null,
  });
  assert.deepEqual(service.enabledProjects, []);
  await service.close();
});
