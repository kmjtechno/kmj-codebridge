import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Python harness: real temp release trees and the real controller functions; no root, no systemd.
const HARNESS = String.raw`
import importlib.util, json, os, shutil, stat, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("ctl", "scripts/production/activate-main-platform-approved.py")
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)
root = Path(tempfile.mkdtemp())
os.chmod(root, 0o755)
ctl.ROOT = root; ctl.RELEASES = root / "releases"; ctl.CURRENT = root / "current"
ctl.SHARED_STORAGE = root / "shared" / "storage"; ctl.TRUST_ANCHOR = root
ctl.trusted_uids = lambda: {os.getuid()}
ctl.LOCK = root / "run.lock"; ctl.LOCK_OWNER_UID = os.getuid()
ctl.RELEASES.mkdir()
(root / "shared").mkdir(mode=0o755); os.chmod(root / "shared", 0o755)
ctl.SHARED_STORAGE.mkdir(mode=0o755); os.chmod(ctl.SHARED_STORAGE, 0o755)
(ctl.SHARED_STORAGE / "app").mkdir()
(ctl.SHARED_STORAGE / "app" / "upload.bin").write_bytes(b"customer data")
ENV = b"APP_KEY=base64:secret\nDB_PASSWORD=hunter2\n"

def release(name, env=ENV, storage="shared"):
    app = ctl.RELEASES / name / "apps/platform"
    app.mkdir(parents=True)
    if env is not None:
        (app / ".env").write_bytes(env)
    if storage == "shared":
        os.symlink(ctl.SHARED_STORAGE, app / "storage")
    elif storage == "real":
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
good = release("cand-good")
out["shared_ok"] = attempt(ctl.verify_continuity, "old", good)
# storage physically inside an OLD release (candidate links to it) would be destroyed by pruning
inold = release("old-inside", storage="real")
linked_inside = release("cand-inside", storage="none")
os.symlink(inold / "apps/platform/storage", linked_inside / "apps/platform/storage")
out["inside_old_release_refused"] = attempt(ctl.verify_continuity, "old-inside", linked_inside)
out["fresh_storage_refused"] = attempt(ctl.verify_continuity, "old", release("cand-fresh", storage="real"))
# integrity of the shared location and its ancestors
os.chmod(ctl.SHARED_STORAGE, 0o777)
out["storage_world_writable"] = attempt(ctl.verify_continuity, "old", good)
os.chmod(ctl.SHARED_STORAGE, 0o755)
os.chmod(root / "shared", 0o775)
out["ancestor_group_writable"] = attempt(ctl.verify_continuity, "old", good)
os.chmod(root / "shared", 0o755)
ctl.trusted_uids = lambda: {os.getuid() + 12345}
out["foreign_owner"] = attempt(ctl.verify_continuity, "old", good)
ctl.trusted_uids = lambda: {os.getuid()}
shutil.rmtree(ctl.SHARED_STORAGE / "app"); (ctl.SHARED_STORAGE / "app").write_bytes(b"x")
out["storage_app_not_dir"] = attempt(ctl.verify_continuity, "old", good)
os.unlink(ctl.SHARED_STORAGE / "app"); (ctl.SHARED_STORAGE / "app").mkdir()
(ctl.SHARED_STORAGE / "app" / "upload.bin").write_bytes(b"customer data")
out["ok_again"] = attempt(ctl.verify_continuity, "old", good)
# .env handling
out["env_differs"] = attempt(ctl.verify_continuity, "old", release("c-envdiff", env=b"APP_KEY=other\n"))
out["env_missing"] = attempt(ctl.verify_continuity, "old", release("c-noenv", env=None))
sym = release("c-envlink", env=None)
os.symlink(old / "apps/platform/.env", sym / "apps/platform/.env")
out["env_symlink"] = attempt(ctl.verify_continuity, "old", sym)
out["env_too_big"] = attempt(ctl.verify_continuity, "old", release("c-big", env=b"A" * 70000))
hard = release("c-hard", env=None)
os.link(old / "apps/platform/.env", hard / "apps/platform/.env")
out["env_hardlink"] = attempt(ctl.verify_continuity, "old", hard)
os.unlink(hard / "apps/platform/.env")
# a short read must not change the digest (full streaming), and a file that changes while read is refused
real_read = os.read
os.read = lambda fd, n: real_read(fd, min(n, 3))
out["short_reads_same_digest"] = attempt(ctl.verify_continuity, "old", good)
grown = []
def growing(fd, n):
    data = real_read(fd, min(n, 5))
    if data and not grown:
        grown.append(1)
        with open(old / "apps/platform/.env", "ab") as f:
            f.write(b"#")
    return data
os.read = growing
out["unstable_env"] = attempt(ctl.read_env_digest, old)
os.read = real_read
(old / "apps/platform/.env").write_bytes(ENV)
# post-switch: exact pointer + unchanged facts
before = ctl.verify_continuity("old", good)
os.symlink("releases/cand-good", ctl.CURRENT)
out["after_switch_ok"] = attempt(ctl.verify_continuity_after_switch, before, "releases/cand-good", good)
out["after_switch_wrong_target"] = attempt(ctl.verify_continuity_after_switch, before, "releases/old", old)
(good / "apps/platform/.env").write_bytes(b"APP_KEY=drift\n")
out["after_switch_env_drift"] = attempt(ctl.verify_continuity_after_switch, before, "releases/cand-good", good)
(good / "apps/platform/.env").write_bytes(ENV)
os.unlink(ctl.CURRENT); os.symlink("releases/old", ctl.CURRENT)
out["after_switch_pointer_not_candidate"] = attempt(ctl.verify_continuity_after_switch, before, "releases/cand-good", good)
os.unlink(ctl.CURRENT)
out["after_switch_pointer_missing"] = attempt(ctl.verify_continuity_after_switch, before, "releases/cand-good", good)
# pruning the old release (rollback cleanup) must not touch uploads
shutil.rmtree(old)
out["uploads_survive_old_release_prune"] = (ctl.SHARED_STORAGE / "app" / "upload.bin").read_bytes().decode()
os.symlink("releases/cand-good", ctl.CURRENT)
out["still_continuous_after_prune"] = attempt(ctl.real_storage, ctl.CURRENT)
os.unlink(ctl.CURRENT)
# root lock: attested by descriptor, never follows a planted link, never truncates
def lock_attempt():
    try:
        with ctl.locked_release_lock():
            return "OK"
    except RuntimeError as error:
        return str(error)
out["lock_ok"] = lock_attempt()
os.unlink(ctl.LOCK)
victim = root / "victim"; victim.write_text("precious")
os.symlink(victim, ctl.LOCK)
out["lock_symlink"] = lock_attempt()
out["victim_untouched"] = victim.read_text()
os.unlink(ctl.LOCK)
ctl.LOCK.write_text(""); os.chmod(ctl.LOCK, 0o600); os.link(ctl.LOCK, root / "lock2")
out["lock_hardlink"] = lock_attempt()
os.unlink(ctl.LOCK); os.unlink(root / "lock2")
ctl.LOCK.write_text(""); os.chmod(ctl.LOCK, 0o666)
out["lock_loose_mode"] = lock_attempt()
os.unlink(ctl.LOCK)
ctl.LOCK.write_text(""); os.chmod(ctl.LOCK, 0o600)
ctl.LOCK_OWNER_UID = os.getuid() + 1
out["lock_foreign_owner"] = lock_attempt()
ctl.LOCK_OWNER_UID = os.getuid()
with ctl.locked_release_lock():
    out["lock_busy"] = lock_attempt()
# Refuse a path replaced in the small interval between first attestation
# and flock; do not report a lock on an unlinked inode as a safe release lock.
old_flock = ctl.fcntl.flock
def replace_at_flock(fd, flags):
    os.rename(ctl.LOCK, root / "old-lock-inode")
    ctl.LOCK.write_bytes(b"new")
    os.chmod(ctl.LOCK, 0o600)
    return old_flock(fd, flags)
ctl.fcntl.flock = replace_at_flock
out["lock_swapped_after_open"] = lock_attempt()
ctl.fcntl.flock = old_flock
os.unlink(ctl.LOCK)
os.unlink(root / "old-lock-inode")
os.mkfifo(ctl.LOCK, 0o600)
out["lock_fifo"] = lock_attempt()
os.unlink(ctl.LOCK)
os.chmod(root, 0o777)
out["lock_unsafe_parent"] = lock_attempt()
os.chmod(root, 0o755)
(root / "real-parent").mkdir()
os.symlink(root / "real-parent", root / "linked-parent")
ctl.LOCK = root / "linked-parent" / "lock"
out["lock_symlink_parent"] = lock_attempt()
ctl.LOCK = root / "run.lock"
# no secret or path may appear in any reported category
text = json.dumps({k: v for k, v in out.items() if k != "uploads_survive_old_release_prune" and k != "victim_untouched"})
out["leaks"] = [s for s in ("hunter2", "APP_KEY", str(root)) if s in text]
print(json.dumps(out))
`;

test(
  "production cutover protects uploads, .env and the root lock (negative and prune cases)",
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
      inside_old_release_refused: "CONTINUITY_STORAGE_NOT_SHARED",
      fresh_storage_refused: "CONTINUITY_STORAGE_NOT_SHARED",
      storage_world_writable: "CONTINUITY_STORAGE_UNTRUSTED",
      ancestor_group_writable: "CONTINUITY_STORAGE_UNTRUSTED",
      foreign_owner: "CONTINUITY_STORAGE_UNTRUSTED",
      storage_app_not_dir: "CONTINUITY_STORAGE_MISSING",
      ok_again: "OK",
      env_differs: "CONTINUITY_ENV_DIFFERS",
      env_missing: "CONTINUITY_ENV_MISSING",
      env_symlink: "CONTINUITY_ENV_MISSING",
      env_too_big: "CONTINUITY_ENV_UNSAFE",
      env_hardlink: "CONTINUITY_ENV_UNSAFE",
      short_reads_same_digest: "OK",
      unstable_env: "CONTINUITY_ENV_UNSTABLE",
      after_switch_ok: "OK",
      after_switch_wrong_target: "CONTINUITY_POINTER_LOST",
      after_switch_env_drift: "CONTINUITY_LOST_AFTER_SWITCH",
      after_switch_pointer_not_candidate: "CONTINUITY_POINTER_LOST",
      after_switch_pointer_missing: "CONTINUITY_POINTER_LOST",
      uploads_survive_old_release_prune: "customer data",
      still_continuous_after_prune: "OK",
      lock_ok: "OK",
      lock_symlink: "LOCK_UNSAFE",
      victim_untouched: "precious",
      lock_hardlink: "LOCK_UNSAFE",
      lock_loose_mode: "LOCK_UNSAFE",
      lock_foreign_owner: "LOCK_UNSAFE",
      lock_busy: "LOCK_BUSY",
      lock_swapped_after_open: "LOCK_UNSAFE",
      lock_fifo: "LOCK_UNSAFE",
      lock_unsafe_parent: "LOCK_UNSAFE",
      lock_symlink_parent: "LOCK_UNSAFE",
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
  const post = main.indexOf(
    "verify_continuity_after_switch(continuity, new_target, candidate)",
  );
  const rollback = main.indexOf("MAIN_PLATFORM_ROLLBACK_VERIFIED");
  assert.ok(pre > 0 && pre < sw, "pre-switch continuity gate");
  assert.ok(
    sw < post && post < rollback,
    "post-switch check precedes rollback",
  );
  assert.match(main.slice(sw, rollback), /try:|except Exception/);
  assert.ok(!/LOCK\.open\(/.test(src), "no path-based lock open");
  assert.match(main, /with locked_release_lock\(\)/);
});

test(
  "Git cleanliness allows ONLY owner-attested shared storage placeholder drift",
  {
    skip: process.platform === "win32" && "requires POSIX symlinks",
  },
  (t) => {
    const code = fs.readFileSync(
      "scripts/production/activate-main-platform-approved.py",
      "utf8",
    );
    const pre = code.indexOf(
      "real_storage(release)",
      code.indexOf("def verify_candidate("),
    );
    const checked = code.indexOf(
      "dirty = run(",
      code.indexOf("def verify_candidate("),
    );
    assert.ok(
      pre > 0 && pre < checked,
      "storage must be attested before Git exclusion",
    );
    assert.ok(code.includes(":(exclude)apps/platform/storage"));
    assert.ok(
      code.includes('if not (release / "apps/platform/storage").is_symlink()'),
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-git-storage-"));
    const shared = fs.mkdtempSync(
      path.join(os.tmpdir(), "kmj-external-storage-"),
    );
    const git = (...args) =>
      spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    try {
      let r = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
      if (r.error) {
        t.skip("git unavailable");
        return;
      }
      assert.equal(r.status, 0, r.stderr);
      const laravel = path.join(dir, "apps/platform");
      const placeholder = path.join(laravel, "storage/app");
      fs.mkdirSync(placeholder, { recursive: true });
      fs.mkdirSync(path.join(shared, "app"), { recursive: true });
      fs.writeFileSync(path.join(placeholder, ".gitignore"), "*\\n");
      fs.writeFileSync(path.join(laravel, "artisan"), "approved baseline");
      r = git(
        "add",
        "apps/platform/storage/app/.gitignore",
        "apps/platform/artisan",
      );
      assert.equal(r.status, 0, r.stderr);
      r = git(
        "-c",
        "user.email=ci@example.invalid",
        "-c",
        "user.name=KMJ CI",
        "commit",
        "-qm",
        "baseline",
      );
      assert.equal(r.status, 0, r.stderr);
      // Runtime provisioning replaces ONLY the tracked Laravel placeholder.
      fs.rmSync(path.join(laravel, "storage"), { recursive: true });
      fs.symlinkSync(shared, path.join(laravel, "storage"), "dir");
      const all = git("status", "--porcelain", "--untracked-files=normal");
      assert.notEqual(
        all.stdout.trim(),
        "",
        "full Git status correctly sees runtime storage drift",
      );
      // The synthetic persistent directory is outside tracked paths, and is
      // explicitly excluded from normal source cleanliness for this test.
      const narrow = (...args) =>
        git(
          "status",
          "--porcelain",
          "--untracked-files=normal",
          "--",
          ".",
          ":(exclude)apps/platform/storage",
          ...args,
        );
      r = narrow();
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "", "only storage is excluded");
      fs.writeFileSync(path.join(laravel, "artisan"), "tampered source");
      r = narrow();
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /artisan/, "other tracked code remains protected");
      fs.writeFileSync(path.join(dir, "untracked-malicious.js"), "alert(1)");
      r = narrow();
      assert.match(
        r.stdout,
        /untracked-malicious/,
        "other untracked source is rejected",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(shared, { recursive: true, force: true });
    }
  },
);
