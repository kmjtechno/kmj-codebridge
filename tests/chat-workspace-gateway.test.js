import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildChatWorkspaceOpen } from "../src/chat-workspace-open.js";

test("gateway intercepts workspace open and reuses only four scoped read tools", () => {
  const source = fs.readFileSync(
    new URL("../src/gateway.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  async function getChatWorkspaceOpen(user, args)");
  const end = source.indexOf("  async function getMultiChatSync(user, args)", start);
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
