import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRunner } from "../src/jobs.js";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-jobs-"));
  const runner = new JobRunner(root, { maxConcurrent: 1 });
  t.after(async () => {
    await runner.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runner };
}
async function finished(r, id) {
  for (let i = 0; i < 100; i++) {
    const j = r.get(id, "p1");
    if (!["running", "queued"].includes(j.state)) return j;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error("job timed out");
}
const opts = (root, key, script) => ({
  project: "p1",
  gate: "unit",
  key,
  cwd: root,
  command: process.execPath,
  args: ["-e", script],
  timeoutMs: 2000,
});
test("runs command without a shell and persists result", async (t) => {
  const { root, runner } = fixture(t);
  const j = runner.run(opts(root, "a", 'console.log("hello")'));
  const done = await finished(runner, j.id);
  assert.equal(done.state, "succeeded");
  assert.equal(done.exitCode, 0);
  assert.match(done.output, /hello/);
});
test("idempotency key returns the same job without executing twice", async (t) => {
  const { root, runner } = fixture(t);
  const o = opts(root, "same", 'console.log("once")');
  const a = runner.run(o);
  const b = runner.run(o);
  assert.equal(a.id, b.id);
  await finished(runner, a.id);
  const reload = new JobRunner(root);
  assert.equal(reload.run(o).id, a.id);
  await reload.close();
});
test("reusing a key for different input is rejected", async (t) => {
  const { root, runner } = fixture(t);
  runner.run(opts(root, "key", "console.log(1)"));
  assert.throws(
    () => runner.run(opts(root, "key", "console.log(2)")),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test("project cannot read another project job", async (t) => {
  const { root, runner } = fixture(t);
  const j = runner.run(opts(root, "job", ""));
  assert.throws(() => runner.get(j.id, "p2"), /JOB_NOT_FOUND/);
});
test("concurrency limit rejects excessive work", async (t) => {
  const { root, runner } = fixture(t);
  runner.run(opts(root, "one", "setTimeout(()=>{},1000)"));
  assert.throws(() => runner.run(opts(root, "two", "")), /BUSY/);
});
test("captures failure and enforces output cap", async (t) => {
  const { root, runner } = fixture(t);
  const j = runner.run(
    opts(root, "fail", 'console.log("x".repeat(200000));process.exit(7)'),
  );
  const done = await finished(runner, j.id);
  assert.equal(done.exitCode, 7);
  assert.equal(done.state, "failed");
  assert.ok(Buffer.byteLength(done.output) <= 32768);
  assert.equal(done.truncated, true);
});
test("timeout terminates the job", async (t) => {
  const { root, runner } = fixture(t);
  const j = runner.run({
    ...opts(root, "timeout", "setTimeout(()=>{},10000)"),
    timeoutMs: 100,
  });
  const done = await finished(runner, j.id);
  assert.equal(done.state, "timed_out");
});
test("cancel terminates a running job", async (t) => {
  const { root, runner } = fixture(t);
  const j = runner.run(opts(root, "cancel", "setTimeout(()=>{},10000)"));
  runner.cancel(j.id, "p1");
  assert.equal((await finished(runner, j.id)).state, "cancelled");
});
test("restart marks stale running records interrupted, never reruns", async (t) => {
  const { root, runner } = fixture(t);
  await runner.close();
  fs.writeFileSync(
    path.join(root, "orphan.json"),
    JSON.stringify({
      id: "orphan",
      project: "p1",
      key: "old",
      fingerprint: "x",
      state: "running",
      output: "",
    }),
  );
  const reload = new JobRunner(root);
  assert.equal(reload.get("orphan", "p1").state, "interrupted");
  await reload.close();
});
test(
  "cancel kills SIGTERM-ignoring descendants even after parent exits",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, runner } = fixture(t);
    const marker = path.join(root, "child.pid"),
      beat = path.join(root, "beat");
    const childCode = `process.on('SIGTERM',()=>{});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(beat)},String(Date.now())),30);`;
    const script = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
    const job = runner.run({
      ...opts(root, "descendant", script),
      timeoutMs: 30000,
    });
    let pid;
    t.after(() => {
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
    });
    for (let i = 0; i < 100 && !fs.existsSync(beat); i++)
      await new Promise((r) => setTimeout(r, 10));
    pid = Number(fs.readFileSync(marker, "utf8"));
    runner.cancel(job.id, "p1");
    await finished(runner, job.id);
    await new Promise((r) => setTimeout(r, 800));
    const before = fs.readFileSync(beat, "utf8");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      fs.readFileSync(beat, "utf8"),
      before,
      "cancelled jobs must not leave running descendants",
    );
  },
);
