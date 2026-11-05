import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const controller = fs.readFileSync(
  "scripts/production/activate-main-platform-approved.py",
  "utf8",
);

const HARNESS = `
import hashlib, importlib.util, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("ctl", "scripts/production/activate-main-platform-approved.py")
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)
uid, gid = os.getuid(), os.getgid()
ctl.trusted_uids = lambda: {0, uid}
ctl.STATE_OWNER_UIDS = (uid,)
NAME = "storage.pre-shared-20261105T091800Z"

def git(cwd, *a):
    env = {"PATH": "/usr/bin:/bin", "HOME": str(cwd), "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(["git", "-C", str(cwd), *a], check=True, capture_output=True, text=True, env=env).stdout.strip()

def world():
    base = Path(os.path.realpath(tempfile.mkdtemp()))
    rel = base / "releases/platform-aaaaaaaaaaaa"
    app = rel / "apps/platform"
    (app / "storage").mkdir(parents=True)
    git(rel, "init", "-q")
    pres = app / NAME
    (pres / "app/private").mkdir(parents=True)
    (pres / "app/.gitignore").write_text("*\\n!.gitignore\\n")
    (pres / "app/private/a.txt").write_text("upload")
    (pres / "app/private/a.txt").chmod(0o640)
    for d in (pres, pres / "app", pres / "app/private"):
        d.chmod(0o750)
    state = base / "state"
    state.mkdir(mode=0o700)
    ctl.STORAGE_STATE = state
    sha = hashlib.sha256(b"upload").hexdigest()
    # Independently spelled parity vector for the switch tool's plan id (persistent files + directory metadata).
    literal = '[[["app/private/a.txt", ["%s", 6, %d, %d, %d]]], [["app", [%d, %d, %d]], ["app/private", [%d, %d, %d]]]]' % (
        sha, 0o640, uid, gid, 0o750, uid, gid, 0o750, uid, gid)
    plan = hashlib.sha256(literal.encode()).hexdigest()[:16]
    key = hashlib.sha256(os.path.realpath(app).encode()).hexdigest()[:12]
    phases = ["begin", "live_frozen", "both_frozen", "link_created", "exchanged", "preserved", "verified", "complete"]
    lines = []
    for i, p in enumerate(phases):
        e = {"t": 1 + i, "phase": p}
        if p == "begin":
            e.update(link=".kmj-storage-link-0123456789abcdef", kept=NAME, plan=plan)
        lines.append(json.dumps(e) + "\\n")
    receipt = state / (key + ".journal.done-1")
    receipt.write_text("".join(lines))
    receipt.chmod(0o600)
    return base, rel, app, pres, state, key, receipt, lines, plan

def attempt(rel):
    try:
        return ctl.preserved_storage_name(rel)
    except RuntimeError as error:
        return str(error)

out = {}
b, rel, app, pres, state, key, receipt, lines, plan = world()
out["parity_plan_matches_literal"] = ctl._storage_plan_id(os.open(pres, os.O_RDONLY | os.O_DIRECTORY)) == plan
out["attested"] = attempt(rel)
out["none_when_absent"] = (shutil.rmtree(pres), attempt(rel))[1]

b, rel, app, pres, state, key, receipt, lines, plan = world()
(pres / "app/private/a.txt").write_text("tampered")
out["tampered"] = attempt(rel)

b, rel, app, pres, state, key, receipt, lines, plan = world()
receipt.unlink()
out["no_receipt"] = attempt(rel)

b, rel, app, pres, state, key, receipt, lines, plan = world()
(app / "storage.pre-shared-20200101T000000Z").mkdir()
out["two_dirs"] = attempt(rel)

b, rel, app, pres, state, key, receipt, lines, plan = world()
(state / (key + ".journal")).write_text('{"t":1,"phase":"begin"}\\n')
out["open_journal"] = attempt(rel)

b, rel, app, pres, state, key, receipt, lines, plan = world()
git(rel, "add", "-f", "apps/platform/" + NAME + "/app/.gitignore")
out["tracked_inside"] = attempt(rel)

b, rel, app, pres, state, key, receipt, lines, plan = world()
receipt.write_text("".join(lines) + '{"t":')
out["torn_receipt"] = attempt(rel)
receipt.write_text("".join(l for l in lines if '"verified"' not in l))
out["never_verified"] = attempt(rel)
receipt.write_text("".join(lines)); receipt.chmod(0o644)
out["receipt_mode"] = attempt(rel)

b, rel, app, pres, state, key, receipt, lines, plan = world()
state.chmod(0o755)
out["state_mode"] = attempt(rel)

b, rel, app, pres, state, key, receipt, lines, plan = world()
extra = state / (key + ".journal.done-9")
extra.write_text(json.dumps({"t": 1, "phase": "rollback_begin", "kept": NAME}) + "\\n"); extra.chmod(0o600)
out["rollback_recorded"] = attempt(rel)

b, rel, app, pres, state, key, receipt, lines, plan = world()
moved = app / "elsewhere"; pres.rename(moved); pres.symlink_to(moved)
out["symlinked_dir"] = attempt(rel)
print(json.dumps(out))
`;

test(
  "controller exempts only a journal-attested preserved storage directory from the clean scan",
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
    const r = JSON.parse(run.stdout);
    assert.equal(r.parity_plan_matches_literal, true);
    assert.equal(r.attested, "storage.pre-shared-20261105T091800Z");
    assert.equal(r.none_when_absent, null);
    for (const key of [
      "tampered",
      "no_receipt",
      "two_dirs",
      "open_journal",
      "tracked_inside",
      "torn_receipt",
      "never_verified",
      "receipt_mode",
      "state_mode",
      "rollback_recorded",
      "symlinked_dir",
    ])
      assert.equal(r[key], "CANDIDATE_PRESERVED_STORAGE_UNATTESTED", key);
  },
);

test("verify_candidate excludes exactly the attested name and nothing broader", () => {
  assert.match(controller, /preserved = preserved_storage_name\(release\)/);
  assert.match(
    controller,
    /excludes\.append\(":\(exclude\)apps\/platform\/" \+ preserved\)/,
  );
  assert.match(controller, /\*excludes,/);
  for (const forbidden of [
    "storage.pre-shared-*",
    "info/exclude",
    "--ignored",
    "skip-worktree",
    "assume-unchanged",
  ])
    assert.ok(!controller.includes(forbidden), forbidden);
});
