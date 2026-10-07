import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const checker = fileURLToPath(new URL("../scripts/check.js", import.meta.url));
function check(t, gateway) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-startup-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of [
    "src",
    "scripts",
    "tests",
    "plugin",
    "claude-plugin/.claude-plugin",
  ])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  const version = "0.2.3";
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version, type: "module" }),
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({ version, packages: { "": { version } } }),
  );
  for (const name of [
    "plugin/plugin.json",
    "claude-plugin/.claude-plugin/plugin.json",
  ])
    fs.writeFileSync(path.join(root, name), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "src/gateway.js"), gateway);
  fs.writeFileSync(
    path.join(root, "src/agent.js"),
    "export function startAgent() {}\n",
  );
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
  });
}
test("release check accepts valid startup graphs", (t) => {
  assert.equal(check(t, "export function startGateway() {}\n").status, 0);
});
test("release check rejects missing ESM exports that syntax checking misses", (t) => {
  const result = check(t, 'import { v4 } from "node:crypto"; export { v4 };\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not provide an export named/);
});
test("release check rejects CommonJS assignments in ESM startup graph", (t) => {
  const result = check(t, "module.exports = {};\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /module is not defined/);
});
