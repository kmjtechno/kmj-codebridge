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
  let licenseCalls = 0;
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
    runner: options.pressure
      ? { capacity: () => ({ blocked: true, constrained: true }) }
      : null,
    licenseProvider: () => {
      licenseCalls++;
      return { features: options.noExecute ? ["read", "write"] : ["execute"] };
    },
  });
  return {
    journal,
    worker,
    project,
    calls: () => calls,
    statusCalls: () => statusCalls,
    licenseCalls: () => licenseCalls,
    enqueue: (key = "auto-draft:feature-a") =>
      journal.enqueue({
        project: "repo",
        key,
        objective: "Implement task safely",
      }),
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
  assert.equal(result.checkpoint.modelUsage.provider, "local-ollama");
  assert.equal(result.checkpoint.modelUsage.model, "qwen3:4b");
  assert.equal(
    result.checkpoint.modelUsage.operation,
    "autopilot_local_worker",
  );
  assert.equal(f.calls(), 1);
  await f.worker.tick();
  assert.equal(f.calls(), 1);
});

test("local Ollama suggestions to change a shared dirty Git checkout are flagged for manual safety review", async (t) => {
  const f = fixture(t);
  const task = f.enqueue("auto-draft:dirty-checkout");
  const local = f.worker.localModel;
  f.worker.localModel = () => ({
    ...local(),
    generate: async () => ({
      response: [
        "Implementation Steps:",
        "1. Isolate checkout:",
        "```bash",
        "git checkout -b isolated-main",
        "git fetch origin",
        "git merge origin/main",
        "```",
        "Follow with tests.",
      ].join("\n"),
      truncated: false,
      hitTokenLimit: false,
    }),
  });
  await f.worker.tick();
  const result = f.journal.get(task.id, "repo");
  assert.equal(result.state, "waiting");
  assert.equal(result.lastReason, "LOCAL_DRAFT_UNSAFE_REVIEW_REQUIRED");
  assert.equal(result.checkpoint.next, "LOCAL_DRAFT_UNSAFE_REVIEW_REQUIRED");
  assert.match(result.checkpoint.summary, /git checkout -b isolated-main/);
  assert.equal(result.checkpoint.modelUsage.paidInference, false);
  // A replay never silently accepts or implements an unsafe local proposal.
  await f.worker.tick();
  assert.equal(
    f.journal.get(task.id, "repo").checkpoint.next,
    "LOCAL_DRAFT_UNSAFE_REVIEW_REQUIRED",
  );
});

test("safe pinned private-lane engineering suggestions remain review-only", async (t) => {
  const f = fixture(t);
  const task = f.enqueue("auto-draft:pinned-private-lane");
  const local = f.worker.localModel;
  f.worker.localModel = () => ({
    ...local(),
    generate: async () => ({
      response:
        "Inspect current Git SHA, propose a fresh pinned private lane, test and request a code review.",
      truncated: false,
      hitTokenLimit: false,
    }),
  });
  await f.worker.tick();
  const result = f.journal.get(task.id, "repo");
  assert.equal(result.state, "waiting");
  assert.equal(result.checkpoint.next, "LOCAL_DRAFT_AWAITING_REVIEW");
});

test("token-limited local model output is persisted but never marked review-ready", async (t) => {
  const f = fixture(t);
  const task = f.enqueue("auto-draft:qwen3-short-reasoning");
  const original = f.worker.localModel;
  f.worker.localModel = () => ({
    ...original(),
    generate: async () => ({
      response: "I should think about the requested change...",
      truncated: false,
      hitTokenLimit: true,
    }),
  });
  await f.worker.tick();
  const state = f.journal.get(task.id, "repo");
  assert.equal(state.state, "waiting");
  assert.equal(state.lastReason, "LOCAL_DRAFT_INCOMPLETE_REVIEW_REQUIRED");
  assert.equal(state.checkpoint.next, "LOCAL_DRAFT_INCOMPLETE_REVIEW_REQUIRED");
  assert.equal(state.checkpoint.modelUsage.provider, "local-ollama");
  assert.match(state.checkpoint.summary, /think about/);
  // Restart/review cannot silently elevate an incomplete result to success.
  await f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
});

test("reply truncation independently makes local proposal incomplete", async (t) => {
  const f = fixture(t);
  const task = f.enqueue("auto-draft:truncated-review");
  const original = f.worker.localModel;
  f.worker.localModel = () => ({
    ...original(),
    generate: async () => ({
      response: "partial response",
      truncated: true,
      hitTokenLimit: false,
    }),
  });
  await f.worker.tick();
  const state = f.journal.get(task.id, "repo");
  assert.equal(state.state, "waiting");
  assert.equal(state.lastReason, "LOCAL_DRAFT_INCOMPLETE_REVIEW_REQUIRED");
  assert.equal(state.checkpoint.next, "LOCAL_DRAFT_INCOMPLETE_REVIEW_REQUIRED");
});

test("ordinary roadmap work is not taken or falsely finished", async (t) => {
  const f = fixture(t);
  const general = f.enqueue("mission:important-milestone");
  await f.worker.tick();
  assert.equal(f.journal.get(general.id, "repo").state, "queued");
  assert.equal(f.calls(), 0);
  assert.equal(f.licenseCalls(), 0);
  assert.equal(f.statusCalls(), 0);
});

test("offline local model preserves task in queued state", async (t) => {
  const f = fixture(t, { offline: true });
  const task = f.enqueue();
  await f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "queued");
  assert.equal(f.calls(), 0);
});

test("resource pressure prevents inference and preserves ready task", async (t) => {
  const f = fixture(t, { pressure: true });
  const task = f.enqueue();
  await f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "queued");
  assert.equal(f.statusCalls(), 0);
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
  assert.equal(f.journal.get(task.id, "repo").checkpoint, null);
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
  assert.equal(
    f.journal.get(task.id, "repo").checkpoint.summary,
    "previous immutable draft",
  );
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
