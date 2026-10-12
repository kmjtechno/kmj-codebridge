import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tryFileSymlink } from "./windows-symlink-capability.js";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts", "setup-gemini-cli.js");
const serverName = "kmj-codebridge";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-gemini-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(dir, ...args) {
  return spawnSync(process.execPath, [cli, "--scope", "project", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

test("Gemini setup is dry-run by default and never creates files silently", (t) => {
  const dir = fixture(t);
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY_RUN/);
  assert.equal(fs.existsSync(path.join(dir, ".gemini")), false);
});

test("Gemini CLI setup preserves existing settings, makes backup and is idempotent", (t) => {
  const dir = fixture(t);
  const folder = path.join(dir, ".gemini");
  fs.mkdirSync(folder);
  const target = path.join(folder, "settings.json");
  const old = {
    ui: { theme: "GitHub" },
    mcpServers: { other: { command: "node", args: ["tool.js"] } },
  };
  const oldRaw = JSON.stringify(old, null, 2) + "\n";
  fs.writeFileSync(target, oldRaw);
  const installed = run(dir, "--yes");
  assert.equal(installed.status, 0, installed.stderr);
  const saved = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(saved.ui, old.ui);
  assert.deepEqual(saved.mcpServers.other, old.mcpServers.other);
  assert.deepEqual(saved.mcpServers[serverName], {
    httpUrl: "https://kmjtechno.com/mcp",
    trust: false,
  });
  const backups = fs.readdirSync(folder).filter((x) => x.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(folder, backups[0]), "utf8"), oldRaw);
  assert.equal(run(dir, "--check").status, 0);
  const again = run(dir, "--yes");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /ALREADY_CONFIGURED/);
  assert.equal(
    fs.readdirSync(folder).filter((x) => x.endsWith(".bak")).length,
    1,
  );
  assert.doesNotMatch(fs.readFileSync(target, "utf8"), /Bearer\s/);
});

test("Gemini setup blocks credential-bearing, insecure and malformed endpoints", (t) => {
  const dir = fixture(t);
  for (const endpoint of [
    "http://example.com/mcp",
    "https://user:pass@example.com/mcp",
    "https://example.com/mcp?token=value",
    "https://example.com/not-mcp",
  ]) {
    const result = run(dir, "--endpoint", endpoint, "--yes");
    assert.notEqual(result.status, 0);
  }
  assert.equal(fs.existsSync(path.join(dir, ".gemini")), false);
});

test("Gemini setup refuses to overwrite an existing CodeBridge connector", (t) => {
  const dir = fixture(t);
  const folder = path.join(dir, ".gemini");
  fs.mkdirSync(folder);
  const target = path.join(folder, "settings.json");
  const existing =
    '{"mcpServers":{"kmj-codebridge":{"httpUrl":"https://old.example/mcp","trust":true}}}';
  fs.writeFileSync(target, existing);
  const result = run(dir, "--yes");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALREADY_CONFIGURED_DIFFERENTLY/);
  assert.equal(fs.readFileSync(target, "utf8"), existing);
});

test("Gemini setup blocks invalid JSON and symlinked configuration", (t) => {
  const dir = fixture(t);
  const folder = path.join(dir, ".gemini");
  fs.mkdirSync(folder);
  const target = path.join(folder, "settings.json");
  fs.writeFileSync(target, "{not-json");
  assert.match(run(dir, "--yes").stderr, /INVALID_JSON/);
  const elsewhere = path.join(dir, "elsewhere.json");
  fs.writeFileSync(elsewhere, "{}");
  fs.unlinkSync(target);
  if (tryFileSymlink(t, elsewhere, target)) {
    const result = run(dir, "--yes");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONFIG_UNSAFE/);
    assert.equal(fs.readFileSync(elsewhere, "utf8"), "{}");
  }
});

test("Gemini setup rejects unexpected switches and conflicting modes", (t) => {
  const dir = fixture(t);
  assert.notEqual(run(dir, "--mode", "unsafe").status, 0);
  assert.notEqual(run(dir, "--yes", "--check").status, 0);
});
