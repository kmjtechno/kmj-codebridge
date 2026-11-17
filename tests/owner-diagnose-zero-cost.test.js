import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const file = "scripts/production/owner_diagnose_zero_cost_20261117.py";
const script = fs.readFileSync(file, "utf8");
const js = script.match(/STAGE_JS = r'''([\s\S]*?)'''/)[1];

test("script compiles", () => {
  const result = spawnSync("python3", [
    "-I",
    "-B",
    "-c",
    "import ast,sys;ast.parse(open(sys.argv[1]).read())",
    file,
  ]);
  assert.equal(result.status, 0);
});

test("embedded stage program is valid ESM", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-diag-"));
  const stage = path.join(dir, "stage.mjs");
  fs.writeFileSync(stage, js);
  const result = spawnSync(process.execPath, ["--check", stage]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, String(result.stderr));
});

test("read-only: root required, runs as the agent user, writes and restarts nothing", () => {
  assert.match(script, /ROOT_REQUIRED/);
  assert.match(script, /"runuser", "-u", user/);
  const py = script.slice(script.indexOf("STAGE_JS") + 10);
  for (const bad of [
    "write_text",
    "unlink",
    "os.replace",
    'systemctl", "restart',
    "daemon-reload",
    "chmod",
    "chown",
  ])
    assert.ok(!py.includes(bad), bad);
  assert.doesNotMatch(js, /writeFile|unlink|rename|POST/);
});

test("never prints the OpenRouter key or its raw response", () => {
  assert.doesNotMatch(js, /console\.log\([^)]*OPENROUTER_KEY/);
  assert.doesNotMatch(js, /JSON\.stringify\(res/);
  assert.doesNotMatch(script, /print\([^)]*(KEY|key|values)/);
  assert.match(script, /usage=" \+ num\(d\.usage\)/);
});

test("reports each verifier stage separately", () => {
  for (const stage of [
    "PIN_READ",
    "SNAPSHOT_READ",
    "OPENROUTER_MODELS",
    "OPENROUTER_KEY_EVIDENCE",
    "VERIFIER",
  ])
    assert.ok(js.includes(stage), stage);
});
