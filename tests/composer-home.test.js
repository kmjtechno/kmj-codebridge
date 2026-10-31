import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRunner, privateComposerHome } from "../src/jobs.js";

const posix = process.platform !== "win32";
const GATE = "command:main_platform_php_deps:ci:build@abc";

function state(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-composer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function finished(r, id) {
  for (let i = 0; i < 150; i++) {
    const j = r.get(id, "p1");
    if (!["running", "queued"].includes(j.state)) return j;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error("job timed out");
}

test("creates a private per-checkout home and reuses it", (t) => {
  const root = state(t);
  const a = privateComposerHome(root, "/srv/checkout-a");
  assert.ok(a && a.startsWith(path.join(root, "composer-homes")));
  assert.equal(privateComposerHome(root, "/srv/checkout-a"), a);
  assert.notEqual(privateComposerHome(root, "/srv/checkout-b"), a);
  if (posix) assert.equal(fs.statSync(a).mode & 0o077, 0);
});

test("a symlinked parent or leaf fails closed", { skip: !posix }, (t) => {
  const root = state(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "cb-elsewhere-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.symlinkSync(elsewhere, path.join(root, "composer-homes"));
  assert.equal(privateComposerHome(root, "/srv/x"), null);
  assert.deepEqual(fs.readdirSync(elsewhere), []); // nothing was created through the link

  const root2 = state(t);
  const leaf = privateComposerHome(root2, "/srv/y");
  fs.rmSync(leaf, { recursive: true });
  fs.symlinkSync(elsewhere, leaf);
  assert.equal(privateComposerHome(root2, "/srv/y"), null);
});

test("group/other accessible parent or leaf fails closed", { skip: !posix }, (t) => {
  const root = state(t);
  const leaf = privateComposerHome(root, "/srv/z");
  fs.chmodSync(leaf, 0o770);
  assert.equal(privateComposerHome(root, "/srv/z"), null);
  fs.chmodSync(leaf, 0o700);
  fs.chmodSync(path.join(root, "composer-homes"), 0o750);
  assert.equal(privateComposerHome(root, "/srv/z"), null);
});

test("a file in place of the directory fails closed", (t) => {
  const root = state(t);
  fs.writeFileSync(path.join(root, "composer-homes"), "x");
  assert.equal(privateComposerHome(root, "/srv/f"), null);
});

test("only the fixed Composer gate gets HOME/COMPOSER_HOME, and inherited HOME is never used", async (t) => {
  const root = state(t);
  const runner = new JobRunner(root, { maxConcurrent: 1 });
  t.after(() => runner.close());
  const probe = 'console.log(JSON.stringify([process.env.HOME??null,process.env.COMPOSER_HOME??null]))';
  const mk = (key, gate) => ({ project: "p1", gate, key, cwd: root, command: process.execPath, args: ["-e", probe], timeoutMs: 5000 });
  const ok = await finished(runner, runner.run(mk("c", GATE)).id);
  assert.equal(ok.state, "succeeded");
  const [home, composer] = JSON.parse(ok.output.trim().split("\n").pop());
  assert.equal(home, composer);
  assert.ok(home.startsWith(path.join(root, "composer-homes")));
  assert.notEqual(home, process.env.HOME);
  const other = await finished(runner, runner.run(mk("o", "unit")).id);
  const [h2, c2] = JSON.parse(other.output.trim().split("\n").pop());
  assert.equal(c2, null);
  assert.notEqual(h2, home);
});

test("an unsafe composer home fails the job before anything is spawned", { skip: !posix }, async (t) => {
  const root = state(t);
  const marker = path.join(root, "ran");
  fs.mkdirSync(path.join(root, "composer-homes"), { mode: 0o755 });
  fs.chmodSync(path.join(root, "composer-homes"), 0o755);
  const runner = new JobRunner(root, { maxConcurrent: 1 });
  t.after(() => runner.close());
  const j = runner.run({
    project: "p1", gate: GATE, key: "u", cwd: root, command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)},"x")`], timeoutMs: 5000,
  });
  const done = await finished(runner, j.id);
  assert.equal(done.state, "failed");
  assert.match(done.output, /JOB_COMPOSER_HOME_UNSAFE/);
  assert.equal(fs.existsSync(marker), false);
});
