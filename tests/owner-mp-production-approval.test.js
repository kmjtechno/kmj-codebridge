import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SCRIPT = "scripts/production/owner_main_platform_production_approval.py";
const script = fs.readFileSync(SCRIPT, "utf8");
const code = script.replace(/"""[\s\S]*?"""/, "");

function py(body) {
  const src = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("r", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}`;
  const r = spawnSync("python3", ["-I", "-B", "-c", src], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("dry run by default; writing needs --apply and both attestations, nothing partial", () => {
  const r = py(`
def attempt(argv):
    try:
        return list(m.parse_args(argv))
    except m.Blocked as e:
        return e.args[0]
F = list(m.FLAGS)
print(json.dumps({
  "none": attempt([]),
  "all": attempt(["--apply"] + F),
  "apply_only": attempt(["--apply"]),
  "partial": attempt(["--apply", F[0]]),
  "flags_no_apply": attempt(F),
  "dup": attempt(["--apply"] + F + ["--apply"]),
  "unknown": attempt(["--apply"] + F + ["--force"]),
}))`);
  assert.deepEqual(r.none, [false, false]);
  assert.deepEqual(r.all, [true, true]);
  assert.equal(r.apply_only, "APPLY_REQUIRES_BOTH_ATTEST_FLAGS");
  assert.equal(r.partial, "APPLY_REQUIRES_BOTH_ATTEST_FLAGS");
  assert.equal(r.flags_no_apply, "ATTEST_FLAGS_REQUIRE_APPLY");
  assert.equal(r.dup, "UNKNOWN_OR_DUPLICATE_ARGUMENT");
  assert.equal(r.unknown, "UNKNOWN_OR_DUPLICATE_ARGUMENT");
});

test("approval has exactly the four keys the Supervisor and controller accept; flags true only when attested", () => {
  const r = py(`
print(json.dumps({"no": m.build_approval(False), "yes": m.build_approval(True),
  "size": len(m.render(m.build_approval(True)))}))`);
  const keys = [
    "approvedSha",
    "backupVerified",
    "expectedCurrentRelease",
    "rollbackVerified",
  ];
  assert.deepEqual(Object.keys(r.no).sort(), keys);
  assert.equal(r.no.backupVerified, false);
  assert.equal(r.no.rollbackVerified, false);
  assert.equal(r.yes.backupVerified, true);
  assert.equal(r.yes.rollbackVerified, true);
  assert.match(r.yes.approvedSha, /^[0-9a-f]{40}$/);
  assert.match(r.yes.expectedCurrentRelease, /^platform-[0-9a-f]{12}$/);
  assert.ok(r.size < 4096);
  // The Supervisor's accepted key list must match (src/supervisor.js).
  const sup = fs.readFileSync("src/supervisor.js", "utf8");
  for (const k of keys) assert.ok(sup.includes('"' + k + '"'));
});

test("backup witness must bind exact SHA, live release and archive digest", () => {
  const r = py(`
import json as j
d = "c" * 64
good = {"approvedSha": m.APPROVED, "currentRelease": m.LIVE_RELEASE, "backupSha256": d}
def run(rec, digest=d, raw=None):
    body = raw if raw is not None else j.dumps(rec).encode()
    try:
        m.check_witness(body, digest)
        return "OK"
    except m.Blocked as e:
        return e.args[0]
print(json.dumps({
  "good": run(good),
  "sha": run({**good, "approvedSha": "d" * 40}),
  "release": run({**good, "currentRelease": "platform-e5b43872bc03"}),
  "digest": run(good, digest="e" * 64),
  "extra": run({**good, "x": 1}),
  "dup": run(None, raw=b'{"approvedSha":"a","approvedSha":"b"}'),
}))`);
  assert.equal(r.good, "OK");
  assert.equal(r.sha, "WITNESS_SHA_MISMATCH");
  assert.equal(r.release, "WITNESS_RELEASE_MISMATCH");
  assert.equal(r.digest, "WITNESS_ARCHIVE_DIGEST_MISMATCH");
  assert.equal(r.extra, "WITNESS_KEYS");
  assert.equal(r.dup, "WITNESS_UNREADABLE");
});

test("pinned, no command execution or network, never activates, single write path after dry-run return", () => {
  assert.match(script, /APPROVED = "[0-9a-f]{40}"/);
  assert.match(script, /LIVE_RELEASE = "platform-[0-9a-f]{12}"/);
  assert.match(script, /\.lower\(\) == "kmj-elite"/);
  assert.match(script, /NOT_ROOT/);
  assert.match(script, /O_NOFOLLOW/);
  assert.doesNotMatch(
    code,
    /subprocess|os\.system|shell=True|systemctl|urllib|socket\.create|\bcurl\b|rm -rf|offsite|sftp|os\.symlink|rename\(/i,
  );
  assert.doesNotMatch(code, /staging-approval|kmjstage/);
  assert.equal((code.match(/write_approval\(/g) || []).length, 2);
  assert.ok(
    code.indexOf("if not apply:") < code.indexOf("+ write_approval(content)"),
  );
  assert.match(script, /PRODUCTION_ACTIVATION=NOT_STARTED/);
});

test("without root it blocks before touching anything", () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const r = spawnSync("python3", ["-I", "-B", SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED_NOT_ROOT/);
  assert.match(r.stdout, /NOTHING_ACTIVATED/);
});
