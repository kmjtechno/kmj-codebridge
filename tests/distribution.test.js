import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const cwd = path.resolve(import.meta.dirname, "..");
test("init creates private configs outside project with hashed gateway credentials", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-init-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const dest = path.join(dir, "config");
  execFileSync(process.execPath, ["scripts/init.js", dest, root], { cwd });
  const gw = JSON.parse(fs.readFileSync(path.join(dest, "gateway.json")));
  const ag = JSON.parse(fs.readFileSync(path.join(dest, "agent.json")));
  assert.equal(gw.users.length, 1);
  assert.match(gw.users[0].tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(ag.token.length, 64);
  assert.ok(!JSON.stringify(gw).includes(ag.token));
  if (process.platform !== "win32")
    assert.equal(
      fs.statSync(path.join(dest, "agent.json")).mode & 0o777,
      0o600,
    );
});
test("init refuses to overwrite existing configuration", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-existing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.notEqual(
    spawnSync(process.execPath, ["scripts/init.js", dir, dir], { cwd }).status,
    0,
  );
});
test("plugin packaging rejects missing and insecure endpoint", () => {
  for (const endpoint of [
    "",
    "http://example.test/mcp",
    "https://user:pass@example.test/mcp",
  ])
    assert.notEqual(
      spawnSync(process.execPath, ["scripts/package-plugin.js", endpoint], {
        cwd,
      }).status,
      0,
    );
});
test("plugin manifest has one identity and accurate workflow", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(cwd, "plugin/plugin.json")),
  );
  assert.equal(manifest.name, "kmj-codebridge");
  assert.equal(
    manifest.extensions["com.openai"].interface.displayName,
    "KMJ CodeBridge",
  );
  assert.ok(fs.existsSync(path.join(cwd, "plugin/skills/codebridge/SKILL.md")));
});

test("init rejects an outside alias resolving into the project before writing secrets", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-init-alias-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const alias = path.join(dir, "alias");
  fs.symlinkSync(
    root,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/init.js", path.join(alias, "config"), root],
    { cwd },
  );
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(root, "config")), false);
});

test("init uses canonical outside destination for agent state", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-init-outside-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const alias = path.join(dir, "alias");
  fs.symlinkSync(
    outside,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  execFileSync(
    process.execPath,
    ["scripts/init.js", path.join(alias, "config"), root],
    { cwd },
  );
  const config = JSON.parse(
    fs.readFileSync(path.join(outside, "config", "agent.json")),
  );
  assert.equal(
    config.stateDir,
    path.join(fs.realpathSync(outside), "config", "state"),
  );
});
