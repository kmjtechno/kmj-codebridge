import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SCRIPT =
  "scripts/production/owner_main_platform_staging_8d105fcd_20261120.py";
const script = fs.readFileSync(SCRIPT, "utf8");
const code = script.replace(/"""[\s\S]*?"""/, "");

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

test("dry run is the default; writing needs --apply plus all four attestations, nothing partial", () => {
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
  "partial": attempt(["--apply"] + F[:3]),
  "flags_no_apply": attempt(F),
  "dup": attempt(["--apply"] + F + ["--apply"]),
  "unknown": attempt(["--apply"] + F + ["--force"]),
}))`);
  assert.deepEqual(r.none, [false, false]);
  assert.deepEqual(r.all, [true, true]);
  assert.equal(r.apply_only, "APPLY_REQUIRES_ALL_FOUR_ATTEST_FLAGS");
  assert.equal(r.partial, "APPLY_REQUIRES_ALL_FOUR_ATTEST_FLAGS");
  assert.equal(r.flags_no_apply, "ATTEST_FLAGS_REQUIRE_APPLY");
  assert.equal(r.dup, "UNKNOWN_OR_DUPLICATE_ARGUMENT");
  assert.equal(r.unknown, "UNKNOWN_OR_DUPLICATE_ARGUMENT");
});

test("approval matches the runner's exact key set; verified flags are false unless attested", () => {
  const r = py(`
cur = "b" * 40
no = m.build_approval(cur, False)
yes = m.build_approval(cur, True)
errs = []
for bad in (m.APPROVED, "xyz", "A" * 40):
    try:
        m.build_approval(bad, True)
        errs.append("ACCEPTED")
    except m.Blocked as e:
        errs.append(e.args[0])
print(json.dumps({"no": no, "yes": yes, "errs": errs,
  "rendered_len": len(m.render(yes))}))`);
  const keys = [
    "schema",
    "approvedSha",
    "expectedCurrentSha",
    "expectedProductionRelease",
    "runnerSha256",
    "unitSha256",
    "backupVerified",
    "rollbackVerified",
    "storageVerified",
    "zeroAdditionalCostVerified",
  ];
  assert.deepEqual(Object.keys(r.no).sort(), [...keys].sort());
  for (const k of keys.slice(6)) {
    assert.equal(r.no[k], false);
    assert.equal(r.yes[k], true);
  }
  assert.equal(r.yes.schema, "kmj.main-platform.staging-approval.v1");
  assert.deepEqual(r.errs, Array(3).fill("EXPECTED_CURRENT_INVALID"));
  assert.ok(r.rendered_len < 4096);
});

test("backup witness must bind the exact SHA, the live release and the archive digest", () => {
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
  "format": run({**good, "backupSha256": "ZZ"}, digest="ZZ"),
  "extra": run({**good, "x": 1}),
  "dup": run(None, raw=b'{"approvedSha":"a","approvedSha":"b"}'),
  "junk": run(None, raw=b"\\xff"),
}))`);
  assert.equal(r.good, "OK");
  assert.equal(r.sha, "WITNESS_SHA_MISMATCH");
  assert.equal(r.release, "WITNESS_RELEASE_MISMATCH");
  assert.equal(r.digest, "WITNESS_ARCHIVE_DIGEST_MISMATCH");
  assert.equal(r.format, "WITNESS_DIGEST_FORMAT");
  assert.equal(r.extra, "WITNESS_KEYS");
  assert.equal(r.dup, "WITNESS_UNREADABLE");
  assert.equal(r.junk, "WITNESS_UNREADABLE");
});

test("exact pins, no command execution, no network, no deploy or production approval write", () => {
  assert.match(script, /APPROVED = "[0-9a-f]{40}"/);
  assert.match(script, /LIVE_RELEASE = "platform-[0-9a-f]{12}"/);
  assert.equal(script.match(/_SHA = "[0-9a-f]{64}"/g).length, 2);
  assert.match(script, /\.lower\(\) == "kmj-elite"/);
  assert.match(script, /NOT_ROOT/);
  assert.match(script, /O_NOFOLLOW/);
  assert.doesNotMatch(
    code,
    /subprocess|os\.system|shell=True|systemctl|urllib|socket\.create|\bcurl\b|rm -rf|offsite|sftp/i,
  );
  assert.doesNotMatch(script, /production-release\.json/);
  // One definition plus exactly one call site, and that call is after the dry-run return.
  assert.equal((code.match(/write_approval\(/g) || []).length, 2);
  assert.ok(
    code.indexOf("if not apply:") < code.indexOf("+ write_approval(content)"),
  );
  assert.match(script, /if not apply:/);
});

test("without root it blocks before touching anything", () => {
  const r = spawnSync("python3", ["-I", "-B", SCRIPT], { encoding: "utf8" });
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  assert.equal(r.status, 2);
  assert.match(r.stdout, /BLOCKED_NOT_ROOT/);
  assert.match(r.stdout, /NOTHING_ACTIVATED/);
});

test("exact release pin is new 8d105fcd candidate against LIVE 98bd predecessor", () => {
  const r = py(`import json
print(json.dumps({"approved": m.APPROVED, "live": m.LIVE_RELEASE, "flags": list(m.FLAGS)}))`);
  assert.equal(r.approved, "8d105fcd41d0b4bb744e8843b5e1200f7d7381fe");
  assert.equal(r.live, "platform-98bd75b69135");
  assert.deepEqual(
    r.flags.sort(),
    [
      "--attest-backup",
      "--attest-rollback",
      "--attest-storage",
      "--attest-zero-cost",
    ].sort(),
  );
});
