import test from "node:test";
import assert from "node:assert/strict";

import {
  needsLegacyContinuity,
  resolveChatWorkspaceCheckpoint,
} from "../src/chat-workspace-continuity.js";
import { buildChatWorkspaceOpen } from "../src/chat-workspace-open.js";

const scope = {
  device: "kmj-elite-main-platform",
  project: "kmj-main-platform",
  lane: "codebridge-24x7",
};
const revision = "a".repeat(64);
const legacy = {
  ok: true,
  value: {
    version: 1,
    project: scope.project,
    lane: scope.lane,
    sequence: 6,
    revision,
    summary: "Review pinned CodeBridge gateway before cutover",
    next: "Verify rollback and project permissions",
    blockers: ["Agent update not installed"],
    chatAutoWake: false,
    contentTrusted: false,
  },
};
const compactEmpty = {
  ok: true,
  value: {
    project: scope.project,
    lane: scope.lane,
    version: 1,
    exists: false,
    revision: null,
  },
};

test("legacy continuity is restored when compact tool is absent", () => {
  const result = resolveChatWorkspaceCheckpoint({
    compact: { ok: false, error: "UNKNOWN_TOOL" },
    legacy,
    scope,
  });
  assert.equal(result.checkpoint.exists, true);
  assert.equal(result.checkpoint.revision, revision);
  assert.deepEqual(result.checkpoint.blockers, ["Agent update not installed"]);
  assert.deepEqual(result.checkpoint.nextSteps, [
    "Verify rollback and project permissions",
  ]);
  assert.equal(result.checkpointSaveTool, "chat_continuity_save");
  const snapshot = buildChatWorkspaceOpen({
    ...scope,
    checkpoint: result.checkpoint,
    checkpointSaveTool: result.checkpointSaveTool,
  });
  assert.equal(snapshot.checkpoint.status, "SAVED");
  assert.equal(snapshot.checkpoint.summary, legacy.value.summary);
  assert.equal(snapshot.hostLimitations.inactiveChatWakeSupported, false);
});

test("legacy continuity is restored when compact tool exists but checkpoint is empty", () => {
  assert.equal(needsLegacyContinuity(compactEmpty, scope), true);
  const { checkpoint, checkpointSaveTool } = resolveChatWorkspaceCheckpoint({
    compact: compactEmpty,
    legacy,
    scope,
  });
  assert.equal(checkpoint.exists, true);
  assert.equal(checkpointSaveTool, "compact_session_save");
});

test("actual saved compact session outranks legacy continuity", () => {
  const compact = {
    ok: true,
    value: {
      project: scope.project,
      lane: scope.lane,
      exists: true,
      revision: "b".repeat(64),
      objective: "Finish reviewed P0 rollout",
      summary: "Compact record is newer",
      blockers: [],
      nextSteps: ["Run exact-head release checks"],
    },
  };
  assert.equal(needsLegacyContinuity(compact, scope), false);
  const result = resolveChatWorkspaceCheckpoint({ compact, legacy, scope });
  assert.equal(result.checkpoint.summary, "Compact record is newer");
  assert.equal(result.checkpointSaveTool, "compact_session_save");
});

test("cross-project and cross-lane legacy data is never disclosed", () => {
  for (const mismatch of [
    { project: "different" },
    { lane: "another-chat" },
    { revision: "../etc/shadow" },
    { sequence: 0 },
    { version: 2 },
    { blockers: ["ok", 3] },
    { summary: "x".repeat(1801) },
  ]) {
    const result = resolveChatWorkspaceCheckpoint({
      compact: compactEmpty,
      legacy: { ok: true, value: { ...legacy.value, ...mismatch } },
      scope,
    });
    assert.equal(result.checkpoint.exists, false);
    assert.equal(
      JSON.stringify(result.checkpoint).includes("etc/shadow"),
      false,
    );
  }
});

test("unavailable records do not manufacture memory, permissions, or auto-wake", () => {
  const result = resolveChatWorkspaceCheckpoint({
    compact: { ok: false },
    legacy: { ok: false },
    scope,
  });
  assert.equal(result.checkpoint, null);
  assert.equal(result.checkpointSaveTool, null);
  const payload = buildChatWorkspaceOpen({
    ...scope,
    checkpoint: result.checkpoint,
    checkpointSaveTool: result.checkpointSaveTool,
  });
  assert.equal(payload.checkpoint.status, "UNAVAILABLE");
  assert.equal(payload.capabilities.checkpointSaveTool, null);
  assert.equal(payload.hostLimitations.automaticUserApproval, false);
  assert.equal(payload.hostLimitations.chatTranscriptCaptured, false);
});
