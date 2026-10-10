import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function run(...args) {
  return spawnSync(process.execPath, ["scripts/client-config.js", ...args], {
    encoding: "utf8",
  });
}

test("universal client config emits credential-free Streamable HTTP OAuth config", () => {
  const r = run("https://bridge.example/mcp", "--format", "generic");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.transport, "streamable-http");
  assert.equal(out.url, "https://bridge.example/mcp");
  assert.equal(out.authentication, "oauth");
  assert.ok(!JSON.stringify(out).match(/Bearer\s+[A-Za-z0-9]/));
});

test("mcp-json and claude-json adapters keep one canonical endpoint", () => {
  for (const format of ["mcp-json", "claude-json"]) {
    const r = run("https://bridge.example/mcp", "--format", format);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.mcpServers["kmj-codebridge"].url,
      "https://bridge.example/mcp",
    );
  }
});

test("client config rejects insecure, credential-bearing and non-mcp endpoints", () => {
  for (const endpoint of [
    "http://bridge.example/mcp",
    "https://user:pass@bridge.example/mcp",
    "https://bridge.example/not-mcp",
    "https://bridge.example/mcp?token=secret",
  ]) {
    const r = run(endpoint);
    assert.notEqual(r.status, 0);
  }
});

test("VS Code and Insiders install links are native one-click and credential-free", () => {
  for (const [format, scheme] of [
    ["vscode-install-url", "vscode:"],
    ["vscode-insiders-install-url", "vscode-insiders:"],
  ]) {
    const r = run("https://kmjtechno.com/mcp", "--format", format);
    assert.equal(r.status, 0, r.stderr);
    const install = new URL(r.stdout.trim());
    assert.equal(install.protocol, scheme);
    assert.equal(install.pathname, "mcp/install");
    const server = JSON.parse(decodeURIComponent(install.search.slice(1)));
    assert.deepEqual(server, {
      name: "kmj-codebridge",
      type: "http",
      url: "https://kmjtechno.com/mcp",
    });
    assert.ok(!r.stdout.includes("Bearer"));
  }
});

test("VS Code install URLs never embed credentials or untrusted MCP targets", () => {
  for (const format of [
    "vscode-install-url",
    "vscode-insiders-install-url",
  ]) {
    for (const endpoint of [
      "https://example.com/mcp?token=secret",
      "https://user:pass@example.com/mcp",
      "http://example.com/mcp",
    ]) {
      const result = run(endpoint, "--format", format);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
    }
  }
});
