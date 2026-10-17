import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const endpoint = "https://bridge.example/mcp";
const clientFormats = [
  "generic",
  "mcp-json",
  "claude-json",
  "claude-cli",
  "vscode-json",
  "vscode-install-url",
  "vscode-insiders-install-url",
  "cursor-json",
  "windsurf-json",
  "gemini-json",
  "gemini-cli",
  "copilot-json",
  "copilot-cli",
  "jetbrains-json",
  "codex-toml",
  "codex-cli",
];

test("all documented Chat/IDE/CLI profiles use same secure OAuth MCP endpoint", () => {
  for (const format of clientFormats) {
    const run = spawnSync(
      process.execPath,
      ["scripts/client-config.js", endpoint, "--format", format],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(run.status, 0, `${format}: ${run.stderr}`);
    assert.ok(run.stdout.includes(endpoint) || run.stdout.includes("bridge.example"));
    assert.equal(run.stderr, "");
    assert.ok(!/Bearer\s+[A-Za-z0-9]|sk-proj-|ghp_[A-Za-z0-9]/.test(run.stdout));
  }
});

test("universal generator never accepts unsafe target or embeds supplied credentials", () => {
  for (const target of [
    "http://bridge.example/mcp",
    "https://user:pass@bridge.example/mcp",
    "https://bridge.example/mcp?access_token=test",
  ]) {
    const r = spawnSync(
      process.execPath,
      ["scripts/client-config.js", target, "--format", "generic"],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
  }
});
