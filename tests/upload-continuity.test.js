import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// Python harness: real temp release trees, the real controller functions, no root, no systemd.
const HARNESS = String.raw`
import importlib.util, json, os, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("ctl", "scripts/production/activate-main-platform-approved.py")
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)
root = Path(tempfile.mkdtemp())
ctl.ROOT = root; ctl.RELEASES = root / "releases"; ctl.CURRENT = root / "current"
ctl.RELEASES.mkdir()

def release(name, env=b"APP_KEY=base64:secret\nDB_PASSWORD=hunter2\n", storage="real"):
    app = ctl.RELEASES / name / "apps/platform"
    app.mkdir(parents=True)
    if env is not None:
        (app / ".env").write_bytes(env)
    if storage == "real":
        (app / "storage/app").mkdir(parents=True)
        (app / "storage/app/upload.bin").write_bytes(b"customer data")
    return ctl.RELEASES / name

def attempt(fn, *a):
    try:
        fn(*a)
        return "OK"
    except RuntimeError as error:
        return str(error)

out = {}
old = release("old")
# shared storage: the candidate's storage is a link to the SAME real directory
shared = release("cand-shared", storage="link")
os.symlink(old / "apps/platform/storage", shared / "apps/platform/storage")
out["shared_ok"] = attempt(ctl.verify_continuity, "old", shared)
# a freshly built candidate (own, empty storage) must be refused: uploads would be orphaned
fresh = release("cand-fresh")
out["fresh_storage_refused"] = attempt(ctl.verify_continuity, "old", fresh)
# a COPY of the files is also refused (cannot be race-free against live uploads)
copy = release("cand-copy")
out["copy_refused"] = attempt(ctl.verify_continuity, "old", copy)
# .env differences / absence / links
envdiff = release("cand-envdiff", env=b"APP_KEY=other\n", storage="link")
os.symlink(old / "apps/platform/storage", envdiff / "apps/platform/storage")
out["env_differs"] = attempt(ctl.verify_continuity, "old", envdiff)
noenv = release("cand-noenv", env=None, storage="link")
os.symlink(old / "apps/platform/storage", noenv / "apps/platform/storage")
out["env_missing"] = attempt(ctl.verify_continuity, "old", noenv)
envlink = release("cand-envlink", env=None, storage="link")
os.symlink(old / "apps/platform/storage", envlink / "apps/platform/storage")
os.symlink(old / "apps/platform/.env", envlink / "apps/platform/.env")
out["env_symlink"] = attempt(ctl.verify_continuity, "old", envlink)
big = release("cand-big", env=b"A" * 70000, storage="link")
os.symlink(old / "apps/platform/storage", big / "apps/platform/storage")
out["env_too_big"] = attempt(ctl.verify_continuity, "old", big)
# storage without app/ is refused
nostore = release("cand-nostore", storage="link")
(root / "empty-storage").mkdir()
os.symlink(root / "empty-storage", nostore / "apps/platform/storage")
out["storage_without_app"] = attempt(ctl.verify_continuity, "old", nostore)
# post-switch check reads through the live pointer: matches for the shared candidate, fails for a drifted one
before = ctl.verify_continuity("old", shared)
os.symlink("releases/cand-shared", ctl.CURRENT)
out["after_switch_ok"] = attempt(ctl.verify_continuity_after_switch, before)
os.unlink(ctl.CURRENT)
os.symlink("releases/cand-fresh", ctl.CURRENT)
out["after_switch_drift"] = attempt(ctl.verify_continuity_after_switch, before)
# no secret or path may appear in any reported category
text = json.dumps(out)
out["leaks"] = [s for s in ("hunter2", "APP_KEY", str(root)) if s in text]
print(json.dumps(out))
`;

test(
  "production cutover refuses to orphan uploads or change .env, and verifies continuity after the switch",
  { skip: process.platform === "win32" && "POSIX-only release controller" },
  (t) => {
    const run = spawnSync("python3", ["-I", "-B", "-c", HARNESS], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    if (run.error) {
      t.skip("python3 unavailable");
      return;
    }
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      shared_ok: "OK",
      fresh_storage_refused: "CONTINUITY_STORAGE_NOT_SHARED",
      copy_refused: "CONTINUITY_STORAGE_NOT_SHARED",
      env_differs: "CONTINUITY_ENV_DIFFERS",
      env_missing: "CONTINUITY_ENV_MISSING",
      env_symlink: "CONTINUITY_ENV_MISSING",
      env_too_big: "CONTINUITY_ENV_UNSAFE",
      storage_without_app: "CONTINUITY_STORAGE_MISSING",
      after_switch_ok: "OK",
      after_switch_drift: "CONTINUITY_LOST_AFTER_SWITCH",
      leaks: [],
    });
  },
);

test("continuity is enforced before the switch and re-verified inside the rollback-protected block", () => {
  const src = fs.readFileSync(
    "scripts/production/activate-main-platform-approved.py",
    "utf8",
  );
  const main = src.slice(src.indexOf("def main()"));
  const pre = main.indexOf("verify_continuity(current, candidate)");
  const sw = main.indexOf('switch_to(new_target, "approved")');
  const post = main.indexOf("verify_continuity_after_switch(continuity)");
  const rollback = main.indexOf("MAIN_PLATFORM_ROLLBACK_VERIFIED");
  assert.ok(pre > 0 && pre < sw, "pre-switch continuity gate");
  assert.ok(
    sw < post && post < rollback,
    "post-switch check precedes the except/rollback handler",
  );
  assert.match(main.slice(sw, rollback), /try:|except Exception/);
});
