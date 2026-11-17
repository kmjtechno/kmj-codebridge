import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "scripts/production/owner_wire_freellmapi_agent_20261117.py";
const script = fs.readFileSync(file, "utf8");
const open3 = script.indexOf('"""');
const code = script.slice(script.indexOf('"""', open3 + 3) + 3); // skip docstring

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

test("dry run is default; apply needs the explicit no-active-jobs flag", () => {
  assert.match(script, /WIRING=DRY_RUN_UNCHANGED/);
  assert.match(
    script,
    /args in \(\[\], \["--apply", "--confirm-no-active-jobs"\]\)/,
  );
});

test("key comes only from a hidden prompt and is never printed or logged", () => {
  assert.match(script, /getpass\.getpass\(/);
  assert.doesNotMatch(script, /sys\.argv\[[^\]]*\]\s*\)?\s*#?.*key/i);
  assert.doesNotMatch(script, /print\([^)]*\bkey\b/);
  assert.match(script, /os\.O_EXCL, 0o600/);
});

test("only an EnvironmentFile drop-in on the agent; nothing else is touched", () => {
  assert.match(script, /EnvironmentFile=\{ENV_FILE\}/);
  for (const bad of [
    "gateway-stage",
    "stable-update",
    "nginx",
    "stable/current",
  ]) {
    assert.ok(!code.includes(bad), bad);
  }
  assert.match(script, /DROPIN_ALREADY_EXISTS/);
  assert.match(script, /ENV_FILE_ALREADY_EXISTS/);
});

test("validates before writing and rolls back only after a write", () => {
  assert.ok(
    script.indexOf("def collect") < script.indexOf("def write_and_restart"),
  );
  assert.match(script, /CHAIN_NOT_ADVERTISED/);
  assert.match(script, /key, chosen = collect\(\)/);
  assert.match(script, /WIRING=FAILED_ROLLED_BACK/);
});

test("never claims generation is enabled", () => {
  assert.match(script, /FREELLMAPI_ZERO_COST_NOT_ATTESTED/);
});
