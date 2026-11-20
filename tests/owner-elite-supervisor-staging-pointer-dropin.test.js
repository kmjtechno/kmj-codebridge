import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SCRIPT =
  "scripts/production/owner_elite_supervisor_staging_pointer_dropin.py";
const script = fs.readFileSync(SCRIPT, "utf8");

function py(body) {
  const src = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("r", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}`;
  const r = spawnSync("python3", ["-I", "-B", "-c", src], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("dry run by default; only --apply accepted", () => {
  const r = py(`
def a(v):
    try:
        return m.parse_args(v)
    except m.Blocked as e:
        return e.args[0]
print(json.dumps({"none": a([]), "apply": a(["--apply"]), "bad": a(["--force"]), "dup": a(["--apply", "--apply"])}))`);
  assert.equal(r.none, false);
  assert.equal(r.apply, true);
  assert.equal(r.bad, "UNKNOWN_ARGUMENT");
  assert.equal(r.dup, "UNKNOWN_ARGUMENT");
});

test("drop-in exposes exactly one read-only path: the staging pointer directory", () => {
  const c = py(`print(json.dumps(m.CONTENT))`);
  const lines = c.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(lines, [
    "[Service]",
    "BindReadOnlyPaths=-/home/kmjstage/htdocs",
  ]);
  // Must match the path the staging policy actually reads.
  const policy = fs.readFileSync(
    "src/main-platform-staging-unit-policy.js",
    "utf8",
  );
  assert.match(
    policy,
    /STAGING_LINK = "\/home\/kmjstage\/htdocs\/staging\.kmjtechno\.com"/,
  );
  assert.doesNotMatch(
    lines.join("\n"),
    /ReadWritePaths|BindPaths=|ProtectHome=|\/home\/kmjstage\/releases/,
  );
});

test("socket-activated: daemon-reload only, no restart; rollback exists; busy release units block", () => {
  assert.deepEqual(
    [...script.matchAll(/ctl\("([a-z-]+)"/g)].map((x) => x[1]).sort(),
    ["daemon-reload", "daemon-reload", "is-active", "show"],
  );
  assert.doesNotMatch(
    script.replace(/"""[\s\S]*?"""/, ""),
    /"restart"|"stop"|"start"/,
  );
  assert.match(script, /kmj-codebridge-supervisor\.socket/);
  assert.match(script, /SUPERVISOR_SOCKET_NOT_ACTIVE/);
  assert.match(script, /def rollback\(\)/);
  assert.match(script, /FAILED_ROLLED_BACK_/);
  assert.match(script, /RELEASE_UNIT_BUSY/);
  assert.match(script, /EXISTING_DROPIN_DIFFERS/);
  assert.match(script, /\.lower\(\) == "kmj-elite"/);
  assert.match(script, /NOT_ROOT/);
});

test("no network, shell, deploy, release pointer, database or secret handling", () => {
  const code = script.replace(/"""[\s\S]*?"""/, "");
  assert.doesNotMatch(
    code,
    /shell=True|os\.system|urllib|curl|wget|stop"|"start"|"enable"|mask|psql|pg_dump|\.env|symlink\(|rename\(|rmtree/i,
  );
});

test("without root it blocks before changing anything", () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const r = spawnSync("python3", ["-I", "-B", SCRIPT, "--apply"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED_NOT_ROOT/);
  assert.match(r.stdout, /NOTHING_CHANGED/);
});
