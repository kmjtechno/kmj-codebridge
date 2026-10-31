import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutopilotJournal } from "../src/autopilot.js";
import {
  LocalFirstCodingWorker,
  parseCodingTask,
  validateCodingPatch,
} from "../src/autopilot-coding-worker.js";
import { WorktreeLanes } from "../src/worktree-lanes.js";
import { reviewRepairCandidate } from "../src/autopilot-repair-review.js";
import { agentSchema } from "../src/config.js";
import { canQueueAutopilotGate } from "../src/autopilot-gate-worker.js";

const PATCH = [
  "diff --git a/src/app.js b/src/app.js",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");
const HEAD = "a".repeat(40);

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture(t, overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-local-coding-"));
  t.after(() =>
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 4 }),
  );
  const root = path.join(base, "repo");
  const state = path.join(base, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  git(root, "init", "-q");
  git(root, "config", "user.name", "CI");
  git(root, "config", "user.email", "ci@example.invalid");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "app.js"),
    "export const value = 1;\n",
  );
  fs.writeFileSync(path.join(root, "README.md"), "preserve this file\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const head = git(root, "rev-parse", "HEAD");
  const journal = new AutopilotJournal(path.join(state, "autopilot"));
  const lanes = new WorktreeLanes(state);
  const jobs = new Map();
  const starts = [];
  let generated = 0;
  const model = {
    status: async () => {
      overrides.onStatus?.();
      if (overrides.statusResponse) await overrides.statusResponse;
      return {
        available: !overrides.offline,
        activeRequest: false,
        models: overrides.offline ? [] : ["qwen3:4b"],
      };
    },
    generate: async () => {
      generated++;
      overrides.onGenerate?.();
      if (overrides.generationFails)
        throw new Error("simulated local model failure");
      return (
        overrides.generated ?? {
          response: PATCH,
          truncated: false,
          hitTokenLimit: false,
        }
      );
    },
  };
  const runner = {
    maxConcurrent: 1,
    capacity: () => ({
      blocked: Boolean(overrides.pressure),
      constrained: false,
      effectiveMaxConcurrent: 1,
      activeJobs: 0,
    }),
    run: (args) => {
      const id = "job-" + (starts.length + 1);
      const record = {
        id,
        project: args.project,
        state: "running",
        exitCode: null,
      };
      jobs.set(id, record);
      starts.push(args);
      return record;
    },
    get: (id) => jobs.get(id),
  };
  const project = {
    id: "repo",
    root,
    writable: true,
    gates: {
      check: {
        command: "node",
        args: ["--test"],
        timeoutMs: 1000,
        autopilotCodingSafe: true,
      },
    },
    autopilotCodingWorker: {
      enabled: overrides.enabled !== false,
      localProcessingApproved: overrides.consent !== false,
      model: "qwen3:4b",
      maxTokens: 256,
      timeoutSeconds: 10,
      recipes: {
        feature: {
          verifyGate: "check",
          paths: ["src/"],
          contextPaths: ["src/app.js"],
        },
      },
    },
  };
  const licenseProvider = () => ({
    features: overrides.noExecute
      ? ["read", "write"]
      : overrides.noWrite
        ? ["read", "execute"]
        : ["write", "execute"],
    limits: { concurrent_jobs: overrides.concurrentJobs ?? 1 },
  });
  const makeWorker = () =>
    new LocalFirstCodingWorker({
      projects: [project],
      canStart: () => overrides.paused !== true,
      journal,
      lanes,
      runner,
      licenseProvider,
      localModel: () => model,
    });
  const enqueue = (key = "auto-code:feature:" + head) =>
    journal.enqueue({
      project: "repo",
      key,
      objective:
        "Change src/app.js value from 1 to 2 and preserve all other files",
    });
  return {
    base,
    root,
    state,
    head,
    journal,
    lanes,
    runner,
    starts,
    jobs,
    project,
    worker: makeWorker(),
    makeWorker,
    enqueue,
    generated: () => generated,
  };
}

test("patch validator allows code-fence text inside an otherwise valid source diff", () => {
  const patch = PATCH.replace(
    "+export const value = 2;",
    "+export const value = 2; // " + String.fromCharCode(96).repeat(3),
  );
  assert.ok(
    validateCodingPatch(patch, {
      paths: ["src/"],
      contextPaths: ["src/app.js"],
      existingPaths: new Set(["src/app.js"]),
    }),
  );
});

test("task parser requires configured recipe and full immutable SHA", () => {
  assert.deepEqual(
    parseCodingTask("auto-code:feature:" + HEAD, { feature: {} }),
    { recipe: "feature", expectedHead: HEAD },
  );
  assert.equal(
    parseCodingTask("auto-code:feature:main", { feature: {} }),
    null,
  );
  assert.equal(
    parseCodingTask("auto-code:unknown:" + HEAD, { feature: {} }),
    null,
  );
  assert.equal(
    canQueueAutopilotGate("auto-code:feature:" + HEAD, ["write"]),
    false,
  );
  assert.equal(
    canQueueAutopilotGate("auto-code:feature:" + HEAD, ["write", "execute"]),
    true,
  );
});

test("coding worker applies a local patch only in a fresh exact-SHA lane and pauses for review after the approved gate", async (t) => {
  const f = fixture(t);
  const dirty = path.join(f.root, "other-agent-untracked.txt");
  fs.writeFileSync(dirty, "preserve");
  const task = f.enqueue();
  await f.worker.tick();

  assert.equal(f.generated(), 1);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].gate, "check");
  assert.notEqual(f.starts[0].cwd, f.root);
  assert.equal(git(f.starts[0].cwd, "rev-parse", "HEAD"), f.head);
  assert.equal(
    fs
      .readFileSync(path.join(f.starts[0].cwd, "src", "app.js"), "utf8")
      .replace(/\r\n/g, "\n"),
    "export const value = 2;\n",
  );
  assert.equal(
    fs
      .readFileSync(path.join(f.root, "src", "app.js"), "utf8")
      .replace(/\r\n/g, "\n"),
    "export const value = 1;\n",
  );
  assert.equal(fs.readFileSync(dirty, "utf8"), "preserve");
  assert.equal(f.journal.get(task.id, "repo").state, "running");
  assert.equal(
    f.journal.get(task.id, "repo").checkpoint.next,
    "LOCAL_CODE_VERIFY_RUNNING",
  );

  f.jobs.get("job-1").state = "succeeded";
  f.jobs.get("job-1").exitCode = 0;
  await f.worker.tick();

  const result = f.journal.get(task.id, "repo");
  assert.equal(result.state, "waiting");
  assert.equal(result.lastReason, "VERIFIED_PATCH_AWAITING_REVIEW");
  assert.equal(result.checkpoint.next, "VERIFIED_PATCH_AWAITING_REVIEW");
  assert.equal(result.checkpoint.modelUsage.provider, "local-ollama");
  assert.equal(result.checkpoint.modelUsage.paidInference, false);

  const review = reviewRepairCandidate({
    project: f.project,
    journal: f.journal,
    lanes: f.lanes,
    taskId: task.id,
    includePatch: true,
  });
  assert.equal(review.candidateType, "local-first-code");
  assert.equal(review.publishStatus, "NOT_PUBLISHED");
  assert.equal(review.expectedHead, f.head);
  assert.deepEqual(review.files, ["src/app.js"]);
  assert.match(review.preview, /export const value = 2/);
  assert.equal(f.starts.length, 1);
});

test("context file replacement before open never reaches model", async (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = (file, flags, ...rest) => {
    if (
      !swapped &&
      typeof file === "string" &&
      file.endsWith(path.join("src", "app.js")) &&
      !file.startsWith(f.root + path.sep)
    ) {
      swapped = true;
      fs.renameSync(file, file + ".original");
      fs.writeFileSync(file, "export const value = 9;\n");
    }
    return originalOpen(file, flags, ...rest);
  };
  try {
    await f.worker.tick();
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(swapped, true);
  assert.equal(f.generated(), 0);
  assert.equal(f.starts.length, 0);
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "LOCAL_CODING_CONTEXT_REJECTED_REVIEW_REQUIRED",
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, "src", "app.js"), "utf8"),
    "export const value = 1;\n",
  );
});

test("stale exact SHA is rejected before local model generation", async (t) => {
  const f = fixture(t);
  const task = f.enqueue("auto-code:feature:" + "b".repeat(40));
  await f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "LOCAL_CODING_LANE_PREPARATION_FAILED",
  );
  assert.equal(f.generated(), 0);
  assert.equal(f.starts.length, 0);
  assert.equal(f.lanes.status("repo", f.root).lanes.length, 0);
});

test("offline model, missing execute permission, or resource pressure leaves task queued", async (t) => {
  for (const options of [
    { offline: true },
    { noExecute: true },
    { concurrentJobs: 0 },
    { pressure: true },
  ]) {
    const f = fixture(t, options);
    const task = f.enqueue();
    await f.worker.tick();
    assert.equal(f.journal.get(task.id, "repo").state, "queued");
    assert.equal(f.starts.length, 0);
    assert.equal(f.generated(), 0);
  }
});

test("authorization revoked during asynchronous model status cannot claim or generate", async (t) => {
  const scenarios = [
    [
      "local consent",
      (f) => {
        f.project.autopilotCodingWorker.localProcessingApproved = false;
      },
    ],
    [
      "project write approval",
      (f) => {
        f.project.writable = false;
      },
    ],
    [
      "execute entitlement",
      (_f, options) => {
        options.noExecute = true;
      },
    ],
    [
      "write entitlement",
      (_f, options) => {
        options.noWrite = true;
      },
    ],
    [
      "concurrent-job entitlement",
      (_f, options) => {
        options.concurrentJobs = 0;
      },
    ],
    [
      "maintenance admission",
      (_f, options) => {
        options.paused = true;
      },
    ],
    [
      "worker disabled",
      (f) => {
        f.project.autopilotCodingWorker.enabled = false;
      },
    ],
    [
      "worker configuration replaced",
      (f) => {
        f.project.autopilotCodingWorker = {
          ...f.project.autopilotCodingWorker,
        };
      },
    ],
    [
      "recipe catalog replaced with an empty catalog",
      (f) => {
        f.project.autopilotCodingWorker.recipes = {};
      },
    ],
    [
      "recipe catalog replaced with an equivalent but newly approved object",
      (f) => {
        f.project.autopilotCodingWorker.recipes = {
          feature: { ...f.project.autopilotCodingWorker.recipes.feature },
        };
      },
    ],
  ];
  for (const [reason, revoke] of scenarios) {
    let releaseStatus;
    let notifyStatusStarted;
    const statusStarted = new Promise((resolve) => {
      notifyStatusStarted = resolve;
    });
    const statusResponse = new Promise((resolve) => {
      releaseStatus = resolve;
    });
    const options = {
      statusResponse,
      onStatus: () => notifyStatusStarted(),
    };
    const f = fixture(t, options);
    const task = f.enqueue();
    const running = f.worker.tick();
    await statusStarted;
    revoke(f, options);
    releaseStatus();
    await running;

    assert.equal(f.journal.get(task.id, "repo").state, "queued", reason);
    assert.equal(f.generated(), 0, reason);
    assert.equal(f.starts.length, 0, reason);
    assert.equal(f.lanes.status("repo", f.root).lanes.length, 0, reason);
    assert.equal(
      fs.readFileSync(path.join(f.root, "src", "app.js"), "utf8"),
      "export const value = 1;\n",
      reason,
    );
  }
});

test("model readiness adopts a reduced positive licensed concurrency before task claim", async (t) => {
  let releaseStatus;
  let notifyStatusStarted;
  const statusStarted = new Promise((resolve) => {
    notifyStatusStarted = resolve;
  });
  const statusResponse = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  const options = {
    concurrentJobs: 2,
    statusResponse,
    onStatus: () => notifyStatusStarted(),
  };
  const f = fixture(t, options);
  const task = f.enqueue();
  const running = f.worker.tick();
  await statusStarted;
  options.concurrentJobs = 1;
  releaseStatus();
  await running;
  assert.equal(f.runner.maxConcurrent, 1);
  assert.equal(f.generated(), 1);
  assert.equal(f.starts.length, 1);
  assert.equal(f.journal.get(task.id, "repo").state, "running");
});

test("authorization revoked during asynchronous local generation cannot mutate a lane or start a gate", async (t) => {
  const scenarios = [
    [
      "local consent",
      (f) => {
        f.project.autopilotCodingWorker.localProcessingApproved = false;
      },
    ],
    [
      "project write approval",
      (f) => {
        f.project.writable = false;
      },
    ],
    [
      "execute entitlement",
      (_f, options) => {
        options.noExecute = true;
      },
    ],
    [
      "write entitlement",
      (_f, options) => {
        options.noWrite = true;
      },
    ],
    [
      "concurrent-job entitlement",
      (_f, options) => {
        options.concurrentJobs = 0;
      },
    ],
    [
      "maintenance admission",
      (_f, options) => {
        options.paused = true;
      },
    ],
    [
      "verification gate approval",
      (f) => {
        f.project.gates.check.autopilotCodingSafe = false;
      },
    ],
  ];
  for (const [reason, revoke] of scenarios) {
    let releaseGeneration;
    let notifyGenerationStarted;
    const generationStarted = new Promise((resolve) => {
      notifyGenerationStarted = resolve;
    });
    const generated = new Promise((resolve) => {
      releaseGeneration = resolve;
    });
    const options = {
      generated,
      onGenerate: () => notifyGenerationStarted(),
    };
    const f = fixture(t, options);
    const task = f.enqueue();
    const running = f.worker.tick();
    await generationStarted;
    revoke(f, options);
    releaseGeneration({
      response: PATCH,
      truncated: false,
      hitTokenLimit: false,
    });
    await running;
    const record = f.journal.get(task.id, "repo");
    assert.equal(record.state, "waiting", reason);
    assert.equal(
      record.lastReason,
      "LOCAL_CODING_AUTHORIZATION_REVOKED_REVIEW_REQUIRED",
      reason,
    );
    assert.equal(f.starts.length, 0, reason);
    assert.equal(f.lanes.status("repo", f.root).lanes.length, 0, reason);
    assert.equal(
      fs.readFileSync(path.join(f.root, "src", "app.js"), "utf8"),
      "export const value = 1;\n",
      reason,
    );
  }
});

test("an unapproved verification gate cannot be executed even when the coding recipe exists", async (t) => {
  const f = fixture(t);
  f.project.gates.check.autopilotCodingSafe = false;
  const task = f.enqueue();
  await f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "LOCAL_CODING_RECIPE_INVALID",
  );
  assert.equal(f.generated(), 0);
  assert.equal(f.starts.length, 0);
});

test("disabled worker or absent local-processing consent cannot start coding", async (t) => {
  for (const options of [{ enabled: false }, { consent: false }]) {
    const f = fixture(t, options);
    const task = f.enqueue();
    await f.worker.tick();
    assert.equal(f.journal.get(task.id, "repo").state, "queued");
    assert.equal(f.generated(), 0);
  }
});

test("out-of-allowlist patch is rejected without applying or running the verification gate", async (t) => {
  const bad = PATCH.replaceAll("src/app.js", "README.md");
  const f = fixture(t, {
    generated: { response: bad, truncated: false, hitTokenLimit: false },
  });
  const task = f.enqueue();
  await f.worker.tick();
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "LOCAL_CODING_PATCH_REJECTED_REVIEW_REQUIRED",
  );
  assert.equal(f.starts.length, 0);
  assert.equal(f.lanes.status("repo", f.root).lanes.length, 0);
  assert.equal(
    fs.readFileSync(path.join(f.root, "README.md"), "utf8"),
    "preserve this file\n",
  );
});

test("incomplete or failed model generation is paused and never silently retried after a checkpoint", async (t) => {
  for (const options of [
    { generated: { response: PATCH, truncated: true, hitTokenLimit: false } },
    { generationFails: true },
  ]) {
    const f = fixture(t, options);
    const task = f.enqueue();
    await f.worker.tick();
    assert.equal(f.journal.get(task.id, "repo").state, "waiting");
    assert.equal(
      f.journal.get(task.id, "repo").lastReason,
      options.generationFails
        ? "LOCAL_CODING_GENERATION_FAILED_REVIEW_REQUIRED"
        : "LOCAL_CODING_OUTPUT_INCOMPLETE_REVIEW_REQUIRED",
    );
    assert.equal(f.starts.length, 0);
    assert.equal(f.lanes.status("repo", f.root).lanes.length, 0);
  }
});

test("restart/resume with an existing coding checkpoint never replays model generation", async (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  await f.worker.tick();
  assert.equal(f.generated(), 1);
  const running = f.journal.get(task.id, "repo");
  const internal = f.journal.state.tasks.find((entry) => entry.id === task.id);
  f.journal.wait(task.id, "repo", "simulated restart", internal.lease.token);
  f.journal.resume(task.id, "repo");
  const restarted = f.makeWorker();
  await restarted.tick();
  assert.equal(f.generated(), 1);
  assert.equal(f.journal.get(task.id, "repo").state, "waiting");
  assert.equal(
    f.journal.get(task.id, "repo").lastReason,
    "PREVIOUS_LOCAL_CODING_REQUIRES_REVIEW",
  );
});

test("missing or unreadable verification job fails closed without replaying inference", async (t) => {
  for (const mode of ["missing", "lookup-error"]) {
    const f = fixture(t);
    const task = f.enqueue();
    await f.worker.tick();
    assert.equal(f.starts.length, 1, mode);
    assert.equal(f.generated(), 1, mode);

    f.runner.get = () => {
      if (mode === "lookup-error") throw new Error("runner state unavailable");
      return undefined;
    };
    await f.worker.tick();

    const record = f.journal.get(task.id, "repo");
    assert.equal(record.state, "waiting", mode);
    assert.equal(
      record.lastReason,
      "LOCAL_CODE_VERIFY_RESULT_UNAVAILABLE_REVIEW_REQUIRED",
      mode,
    );
    assert.notEqual(
      record.checkpoint.next,
      "VERIFIED_PATCH_AWAITING_REVIEW",
      mode,
    );
    assert.equal(f.worker.active.size, 0, mode);
    assert.equal(f.lanes.status("repo", f.root).lanes.length, 1, mode);
    assert.equal(
      fs.readFileSync(path.join(f.root, "src", "app.js"), "utf8"),
      "export const value = 1;\n",
      mode,
    );
    await f.worker.tick();
    assert.equal(f.generated(), 1, mode);
    assert.equal(f.starts.length, 1, mode);
  }
});

test("failed verification gate leaves the candidate unpublishable", async (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  await f.worker.tick();
  f.jobs.get("job-1").state = "failed";
  f.jobs.get("job-1").exitCode = 1;
  await f.worker.tick();
  const result = f.journal.get(task.id, "repo");
  assert.equal(result.state, "waiting");
  assert.equal(result.lastReason, "LOCAL_CODE_VERIFY_FAILED_REVIEW_REQUIRED");
  assert.notEqual(result.lastReason, "VERIFIED_PATCH_AWAITING_REVIEW");
  assert.equal(
    fs.readFileSync(path.join(f.root, "src", "app.js"), "utf8"),
    "export const value = 1;\n",
  );
});

test("revoked authorization after a successful gate never promotes a patch to verified review", async (t) => {
  const scenarios = [
    [
      "local consent",
      (f) => {
        f.project.autopilotCodingWorker.localProcessingApproved = false;
      },
    ],
    [
      "project write grant",
      (f) => {
        f.project.writable = false;
      },
    ],
    [
      "write entitlement",
      (_f, options) => {
        options.noWrite = true;
      },
    ],
    [
      "execute entitlement",
      (_f, options) => {
        options.noExecute = true;
      },
    ],
    [
      "concurrent-job entitlement",
      (_f, options) => {
        options.concurrentJobs = 0;
      },
    ],
    [
      "safe verification gate",
      (f) => {
        f.project.gates.check.autopilotCodingSafe = false;
      },
    ],
    [
      "replaced worker config",
      (f) => {
        f.project.autopilotCodingWorker = {
          ...f.project.autopilotCodingWorker,
        };
      },
    ],
  ];
  for (const [reason, revoke] of scenarios) {
    const options = {};
    const f = fixture(t, options);
    const task = f.enqueue();
    await f.worker.tick();
    assert.equal(f.starts.length, 1, reason);
    f.jobs.get("job-1").state = "succeeded";
    f.jobs.get("job-1").exitCode = 0;
    revoke(f, options);
    await f.worker.tick();
    const record = f.journal.get(task.id, "repo");
    assert.equal(record.state, "waiting", reason);
    assert.equal(
      record.lastReason,
      "LOCAL_CODING_AUTHORIZATION_REVOKED_REVIEW_REQUIRED",
      reason,
    );
    assert.notEqual(
      record.checkpoint.next,
      "VERIFIED_PATCH_AWAITING_REVIEW",
      reason,
    );
    assert.equal(
      fs.readFileSync(path.join(f.root, "src", "app.js"), "utf8"),
      "export const value = 1;\n",
      reason,
    );
    assert.equal(f.starts.length, 1, reason);
  }
});

test("in-place approval mutation during generation cannot expand edits or run a changed gate", async (t) => {
  const scenarios = [
    [
      "edit allowlist",
      (f) => f.project.autopilotCodingWorker.recipes.feature.paths.push("README.md"),
    ],
    [
      "context allowlist",
      (f) =>
        f.project.autopilotCodingWorker.recipes.feature.contextPaths.push(
          "README.md",
        ),
    ],
    ["gate command", (f) => (f.project.gates.check.command = "sh")],
    ["gate arguments", (f) => f.project.gates.check.args.push("-c")],
    [
      "model identity",
      (f) => (f.project.autopilotCodingWorker.model = "unapproved:model"),
    ],
  ];
  for (const [label, mutate] of scenarios) {
    let notifyStarted;
    let releaseGeneration;
    const started = new Promise((resolve) => {
      notifyStarted = resolve;
    });
    const generated = new Promise((resolve) => {
      releaseGeneration = resolve;
    });
    const f = fixture(t, {
      generated,
      onGenerate: () => notifyStarted(),
    });
    const task = f.enqueue();
    const running = f.worker.tick();
    await started;
    mutate(f);
    releaseGeneration({
      response: PATCH,
      truncated: false,
      hitTokenLimit: false,
    });
    await running;
    const result = f.journal.get(task.id, "repo");
    assert.equal(result.state, "waiting", label);
    assert.equal(
      result.lastReason,
      "LOCAL_CODING_AUTHORIZATION_REVOKED_REVIEW_REQUIRED",
      label,
    );
    assert.equal(f.starts.length, 0, label);
    assert.equal(
      fs.readFileSync(path.join(f.root, "src", "app.js"), "utf8"),
      "export const value = 1;\n",
      label,
    );
  }
});

test("in-place verification gate mutation after CI cannot promote a patch", async (t) => {
  const f = fixture(t);
  const task = f.enqueue();
  await f.worker.tick();
  assert.equal(f.starts.length, 1);
  f.jobs.get("job-1").state = "succeeded";
  f.jobs.get("job-1").exitCode = 0;
  // The same gate object remains approved, but its executable was replaced.
  f.project.gates.check.command = "sh";
  await f.worker.tick();
  const result = f.journal.get(task.id, "repo");
  assert.equal(result.state, "waiting");
  assert.equal(
    result.lastReason,
    "LOCAL_CODING_AUTHORIZATION_REVOKED_REVIEW_REQUIRED",
  );
  assert.notEqual(result.checkpoint.next, "VERIFIED_PATCH_AWAITING_REVIEW");
  assert.equal(f.starts.length, 1);
});

test("config requires explicit consent and keeps context files within the edit allowlist", () => {
  const base = {
    gateway: "https://example.invalid/",
    token: "t".repeat(32),
    id: "device1",
    tenant: "tenant1",
    stateDir: "/tmp/codebridge-state",
    license: { mode: "free" },
    projects: [
      {
        id: "repo",
        root: "/tmp/repo",
        writable: true,
        gates: {
          check: {
            command: "node",
            args: [],
            timeoutMs: 1000,
            autopilotCodingSafe: true,
          },
        },
        autopilotCodingWorker: {
          enabled: true,
          localProcessingApproved: true,
          model: "qwen3:4b",
          recipes: {
            feature: {
              verifyGate: "check",
              paths: ["src/"],
              contextPaths: ["src/app.js"],
            },
          },
        },
      },
    ],
  };
  assert.equal(agentSchema.safeParse(base).success, true);
  const noSafeGate = structuredClone(base);
  noSafeGate.projects[0].gates.check.autopilotCodingSafe = false;
  assert.equal(agentSchema.safeParse(noSafeGate).success, false);
  const missingExplicitGateApproval = structuredClone(base);
  delete missingExplicitGateApproval.projects[0].gates.check
    .autopilotCodingSafe;
  assert.equal(
    agentSchema.safeParse(missingExplicitGateApproval).success,
    false,
  );
  const noConsent = structuredClone(base);
  noConsent.projects[0].autopilotCodingWorker.localProcessingApproved = false;
  assert.equal(agentSchema.safeParse(noConsent).success, false);
  const outside = structuredClone(base);
  outside.projects[0].autopilotCodingWorker.recipes.feature.contextPaths = [
    "README.md",
  ];
  assert.equal(agentSchema.safeParse(outside).success, false);
  const missingGate = structuredClone(base);
  missingGate.projects[0].autopilotCodingWorker.recipes.feature.verifyGate =
    "missing";
  assert.equal(agentSchema.safeParse(missingGate).success, false);
  const missingRecipes = structuredClone(base);
  delete missingRecipes.projects[0].autopilotCodingWorker.recipes;
  assert.equal(agentSchema.safeParse(missingRecipes).success, false);
});
