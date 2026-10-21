import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChatWorkspaceOpen } from "../src/chat-workspace-open.js";
import { createDispatcher, definitions } from "../src/tools.js";

test("snapshot contains only bounded workspace facts, never raw tool metadata", () => {
  const result = buildChatWorkspaceOpen({
    device: "device1",
    project: "project1",
    lane: "chat-a",
    writable: true,
    explorer: {
      entries: [
        { path: "src/main.js", type: "file", depth: 1, token: "NEVER_EXPOSE" },
        { path: ".env", type: "file", depth: 0 },
        { path: "src/../private", type: "file", depth: 1 },
        { path: "README.md", type: "file", depth: 0 },
      ],
      truncated: false,
    },
    environment: {
      stacks: ["node"],
      frameworks: [],
      packageManagers: ["npm"],
      originalEnv: "DO_NOT_COPY",
    },
    qualityGates: ["fast"],
    progress: {
      taskTrackingAvailable: false,
      trackedTasksTotal: null,
      trackedTasksSucceededPercent: null,
      nextReadyTaskId: null,
      attention: ["AUTOPILOT_JOURNAL_UNAVAILABLE"],
      jobs: {
        recent: [
          {
            id: "job-1",
            gate: "check",
            state: "succeeded",
            exitCode: 0,
            output: "HIDDEN_LOG_VALUE",
          },
        ],
      },
    },
    checkpoint: {
      exists: true,
      revision: "a".repeat(64),
      objective: "Build offline browser",
      summary: "Source change is pending review",
      blockers: ["Browser QA evidence needed"],
      nextSteps: ["Run exact-head CI"],
      handoff: "UNTRUSTED_FULL_TRANSCRIPT",
    },
    browser: {
      fidelity: { installed: true, path: "PRIVATE_BINARY_PATH" },
      fast: { installed: false },
      plan: { visualQa: "chromium" },
    },
  });
  assert.deepEqual(
    result.workspace.explorer.entries.map((e) => e.path),
    ["src/main.js", "README.md"],
  );
  assert.equal(result.browser.launchVerified, false);
  assert.equal(result.checkpoint.reportedNotVerified, true);
  assert.equal(result.hostLimitations.inactiveChatWakeSupported, false);
  assert.equal(result.progress.recentJobs[0].state, "succeeded");
  for (const unsafe of [
    "NEVER_EXPOSE",
    "DO_NOT_COPY",
    "HIDDEN_LOG_VALUE",
    "PRIVATE_BINARY_PATH",
    "UNTRUSTED_FULL_TRANSCRIPT",
  ])
    assert.ok(!JSON.stringify(result).includes(unsafe), unsafe);
  const compact = buildChatWorkspaceOpen({
    device: "device1",
    project: "project1",
    lane: "chat-a",
    writable: true,
    explorer: {
      entries: [
        { path: "src/main.js", type: "file", depth: 1 },
        { path: ".env", type: "file", depth: 0 },
        { path: "src/../private", type: "file", depth: 1 },
        { path: "README.md", type: "file", depth: 0 },
      ],
      truncated: false,
    },
    environment: { stacks: ["node"], frameworks: [], packageManagers: ["npm"] },
    qualityGates: ["fast"],
    progress: {
      taskTrackingAvailable: false,
      trackedTasksTotal: null,
      trackedTasksSucceededPercent: null,
      nextReadyTaskId: null,
      attention: ["AUTOPILOT_JOURNAL_UNAVAILABLE"],
      jobs: {
        recent: [
          { id: "job-1", gate: "check", state: "succeeded", exitCode: 0 },
        ],
      },
    },
    checkpoint: {
      exists: true,
      revision: "a".repeat(64),
      objective: "Build offline browser",
      summary: "Source change is pending review",
      blockers: ["Browser QA evidence needed"],
      nextSteps: ["Run exact-head CI"],
    },
    browser: {
      fidelity: { installed: true },
      fast: { installed: false },
      plan: { visualQa: "chromium" },
    },
    ifNoneMatch: result.revision,
  });
  assert.equal(compact.unchanged, true);
  assert.equal(compact.revision, result.revision);
  assert.equal(compact.workspace, undefined);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-ai-chat-workspace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const other = path.join(dir, "other");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(repo);
  fs.mkdirSync(other);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(
    path.join(repo, "package.json"),
    '{"name":"workspace-test"}',
  );
  fs.writeFileSync(path.join(repo, "README.md"), "safe public content");
  const runner = {
    maxConcurrent: 1,
    list(project, limit) {
      return {
        project,
        summary: {
          queued: 0,
          running: 0,
          succeeded: 1,
          failed: 0,
          cancelled: 0,
          timed_out: 0,
          interrupted: 0,
        },
        jobs: [
          {
            id: "job-1",
            gate: "check",
            state: "succeeded",
            exitCode: 0,
            endedAt: "2026-10-21T00:00:00.000Z",
          },
        ].slice(0, limit),
        archivedJobs: 0,
      };
    },
  };
  const dispatch = createDispatcher(
    {
      id: "device1",
      stateDir,
      projects: [
        {
          id: "project1",
          root: repo,
          writable: true,
          gates: { fast: [] },
          commands: {},
        },
        { id: "other", root: other, writable: false, gates: {}, commands: {} },
      ],
    },
    runner,
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  return { dispatch };
}

test("ordinary chat can open and resume a project in one scoped read-only call", async (t) => {
  const { dispatch } = fixture(t);
  const input = { device: "device1", project: "project1", lane: "tab-one" };
  const opened = await dispatch("chat_workspace_open", input, ["read"]);
  assert.equal(opened.kind, "codebridge.chat_workspace_open");
  assert.equal(opened.workspace.writable, true);
  assert.equal(opened.checkpoint.status, "NONE");
  assert.equal(opened.progress.taskTrackingAvailable, false);
  assert.equal(opened.progress.recentJobs[0].id, "job-1");
  assert.ok(
    opened.workspace.explorer.entries.some((x) => x.path === "README.md"),
  );
  assert.equal(opened.hostLimitations.chatTranscriptCaptured, false);
  assert.equal(definitions.chat_workspace_open.access, "read");

  const saved = await dispatch(
    "compact_session_save",
    {
      ...input,
      requestKey: "checkpoint-1",
      expectedRevision: null,
      objective: "Resume browser Work milestone",
      summary: "Review approval-gated browser design",
      decisions: [],
      constraints: ["Keep KMJ Main Platform as account authority"],
      evidence: ["CI is not yet independently verified"],
      blockers: ["Interactive browser still pending"],
      nextSteps: ["Review the current exact head"],
    },
    ["write"],
  );
  assert.equal(saved.checkpointSaved, true);
  const resumed = await dispatch("chat_workspace_open", input, ["read"]);
  assert.equal(resumed.checkpoint.status, "SAVED");
  assert.equal(resumed.checkpoint.objective, "Resume browser Work milestone");
  assert.equal(
    resumed.checkpoint.nextSteps[0],
    "Review the current exact head",
  );
  assert.notEqual(resumed.revision, opened.revision);
  const unchanged = await dispatch(
    "chat_workspace_open",
    { ...input, ifNoneMatch: resumed.revision },
    ["read"],
  );
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.workspace, undefined);

  const another = await dispatch(
    "chat_workspace_open",
    { device: "device1", project: "other", lane: "tab-one" },
    ["read"],
  );
  assert.equal(another.checkpoint.status, "NONE");
  assert.equal(another.workspace.writable, false);

  await assert.rejects(
    dispatch("chat_workspace_open", { ...input, device: "other" }, ["read"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("chat_workspace_open", input, ["write"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("chat_workspace_open", { ...input, project: "unknown" }, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
});
