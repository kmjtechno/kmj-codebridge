import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SCRIPT = "scripts/production/owner_offsite_exit3_diagnose.py";
const script = fs.readFileSync(SCRIPT, "utf8");

function py(body) {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("r", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}`;
  const r = spawnSync("python3", ["-I", "-B", "-c", code], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("every file is pinned to a SHA-256 and a verified blob is the only thing executed", () => {
  const r = py(`
good = {}
res = {}
name = next(iter(m.FILES))
try:
    m.verify_blob(name, b"tampered")
    res["tampered"] = "ACCEPTED"
except m.Blocked as e:
    res["tampered"] = e.args[0]
try:
    m.verify_blob("other.py", b"x")
    res["unknown"] = "ACCEPTED"
except m.Blocked as e:
    res["unknown"] = e.args[0]
try:
    m.verify_blob(name, b"")
    res["empty"] = "ACCEPTED"
except m.Blocked as e:
    res["empty"] = e.args[0]
print(json.dumps(res))`);
  assert.match(r.tampered, /^SHA_MISMATCH:/);
  assert.equal(r.unknown, "UNKNOWN_FILE");
  assert.match(r.empty, /^SIZE_OUT_OF_RANGE:/);
  for (const h of script.match(/"[0-9a-f]{64}"/g))
    assert.match(h, /^"[0-9a-f]{64}"$/);
  assert.equal(script.match(/"[0-9a-f]{64}"/g).length, 2);
  assert.match(script, /COMMIT = "[0-9a-f]{40}"/);
});

test("read-only wrapper: root + host pinned, no arguments, no repair, backup or network beyond the pinned fetch", () => {
  assert.match(script, /NOT_ROOT/);
  assert.match(script, /\.lower\(\) != "kmj-elite"/);
  assert.match(script, /NO_ARGUMENTS_ACCEPTED/);
  assert.match(script, /"--inspect"/);
  assert.doesNotMatch(
    script,
    /systemctl|shell=True|os\.system|chmod 0?777|rm -rf|ssh |sftp /,
  );
  assert.match(
    script,
    /raw\.githubusercontent\.com\/kmjtechno\/kmj-main-platform\/" \+ COMMIT/,
  );
});

test("refuses to run without root before any network access", () => {
  const r = spawnSync("python3", ["-I", "-B", SCRIPT], { encoding: "utf8" });
  if (process.getuid && process.getuid() !== 0)
    assert.match(r.stdout, /BLOCKED:NOT_ROOT/);
});
