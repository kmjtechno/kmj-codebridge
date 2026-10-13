import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const HARNESS = `
import hashlib, importlib.util, json, os, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("ctl", "scripts/production/activate-main-platform-approved.py")
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)
ctl.protected_regular = lambda path: os.lstat(path)  # root ownership cannot be faked in a test
sha = "1a06efbfa638b15094a533ae7981609c433aa6c4"
old = "commerce-3315f2a-20261009"
tmp = Path(tempfile.mkdtemp())
ctl.BACKUP_ROOT = tmp
archive = tmp / ("pre-deploy-" + sha[:12] + ".tar.gz")
witness = tmp / ("pre-deploy-" + sha[:12] + ".json")
archive.write_bytes(b"backup bytes")
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
assert len(digest) == 64

def attempt(value):
    witness.write_text(json.dumps({"approvedSha": sha, "currentRelease": old, "backupSha256": value}))
    try:
        ctl.verify_backup(sha, old)
        return "OK"
    except RuntimeError as error:
        return str(error)

print(json.dumps({
    "real_sha256": attempt(digest),
    "wrong_digest": attempt("0" * 64),
    "git_length_value": attempt(digest[:40]),
    "not_hex": attempt("z" * 64),
}))
`;

test("a real 64-character SHA-256 backup witness is accepted and tampering is refused", (t) => {
  const run = spawnSync("python3", ["-I", "-c", HARNESS], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (run.error) {
    t.skip("python3 unavailable");
    return;
  }
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    real_sha256: "OK",
    wrong_digest: "BACKUP_CHECKSUM_MISMATCH",
    git_length_value: "BACKUP_WITNESS_MISMATCH",
    not_hex: "BACKUP_WITNESS_MISMATCH",
  });
});
