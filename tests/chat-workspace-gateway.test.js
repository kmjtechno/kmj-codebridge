import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildChatWorkspaceOpen } from "../src/chat-workspace-open.js";

test("gateway intercepts workspace open and reuses only four scoped read tools", () => {
  const source = fs.readFileSync(
    new URL("../src/gateway.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "  async function getChatWorkspaceOpen(user, args)",
  );
  const end = source.indexOf(
    "  async function getMultiChatSync(user, args)",
    start,
  );
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /authorize\(user, args, "read"\)/);
  assert.match(block, /\.\.\.scope/);
  for (const tool of [
    "workspace_home",
    "project_progress",
    "compact_session_resume",
    "browser_runtime_status",
  ])
    assert.match(block, new RegExp('read\\("' + tool + '"'));
  assert.match(block, /read\\("chat_continuity_read"/);
  assert.match(block, /legacyCheckpoint/);
  assert.match(block, /UNSUPPORTED_ON_AGENT/);
  assert.match(block, /buildChatWorkspaceOpen/);
  assert.doesNotMatch(
    block,
    /run_quality_gate|write_file|execFileSync|spawn\(/,
  );
  assert.match(source, /if \(name === "chat_workspace_open"\)/);
  assert.match(
    source,
    /const result = await getChatWorkspaceOpen\(user, args\)/,
  );
});

test("older-agent missing optional features remain unavailable, not fabricated", () => {
  const packet = buildChatWorkspaceOpen({
    device: "device1",
    project: "project1",
    lane: "work",
    writable: null,
    environment: null,
    explorer: null,
    progress: null,
    checkpoint: null,
    browser: null,
    qualityGates: null,
  });
  assert.equal(packet.workspace.writable, null);
  assert.equal(packet.workspace.explorer.status, "UNAVAILABLE");
  assert.equal(packet.workspace.explorer.truncated, null);
  assert.equal(packet.progress, null);
  assert.equal(packet.checkpoint.status, "UNAVAILABLE");
  assert.equal(packet.browser, null);
  assert.equal(packet.hostLimitations.inactiveChatWakeSupported, false);
  assert.match(packet.revision, /^[a-f0-9]{64}$/);
  const changed = buildChatWorkspaceOpen({
    device: "device1",
    project: "project1",
    lane: "work",
    writable: null,
    environment: null,
    explorer: { truncated: false },
    progress: null,
    checkpoint: null,
    browser: null,
    qualityGates: null,
  });
  assert.equal(changed.workspace.explorer.status, "UNAVAILABLE");
  assert.equal(changed.workspace.explorer.truncated, null);
});

test("gateway compatibility never recommends missing browser or compact-session tools", () => {
  const result = buildChatWorkspaceOpen({
    device: "device1",
    project: "project1",
    lane: "main",
    writable: true,
    environment: null,
    explorer: null,
    progress: null,
    checkpoint: {
      exists: true,
      revision: "a".repeat(64),
      summary: "Review the current Git SHA before production activation",
      nextSteps: ["Run isolated checks"],
      blockers: ["Legacy browser tool is unsupported"],
    },
    browser: null,
    browserCapability: "UNSUPPORTED_ON_AGENT",
    checkpointSaveTool: "chat_continuity_save",
    qualityGates: null,
  });
  assert.equal(result.checkpoint.status, "SAVED");
  assert.equal(
    result.checkpoint.summary,
    "Review the current Git SHA before production activation",
  );
  assert.deepEqual(result.checkpoint.nextSteps, ["Run isolated checks"]);
  assert.equal(result.capabilities.browserRuntime, "UNSUPPORTED_ON_AGENT");
  assert.equal(result.capabilities.checkpointSaveTool, "chat_continuity_save");
  assert.ok(result.nextTools.includes("chat_continuity_save"));
  assert.ok(!result.nextTools.includes("compact_session_save"));
  assert.ok(!result.nextTools.includes("browser_runtime_status"));
  assert.equal(result.browser, null);

  const noCheckpoint = buildChatWorkspaceOpen({
    device: "device1",
    project: "project1",
    lane: "main",
    checkpoint: null,
    browser: null,
    checkpointSaveTool: null,
    browserCapability: "UNAVAILABLE",
  });
  assert.equal(noCheckpoint.checkpoint.status, "UNAVAILABLE");
  assert.equal(noCheckpoint.capabilities.checkpointSaveTool, null);
  assert.ok(!noCheckpoint.nextTools.includes("compact_session_save"));
  assert.ok(!noCheckpoint.nextTools.includes("chat_continuity_save"));
});
