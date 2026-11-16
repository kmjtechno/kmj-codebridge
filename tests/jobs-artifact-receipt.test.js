import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRunner } from "../src/jobs.js";
import { buildArtifactReceipt } from "../src/artifact-receipt.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-jobs-art-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cb-work-art-"));
  const runner = new JobRunner(root, { maxConcurrent: 1 });
  t.after(async () => {
    await runner.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });
  return { root, work, runner };
}
async function finished(r, id) {
  for (let i = 0; i < 150; i++) {
    const j = r.get(id, "p1");
    if (!["running", "queued"].includes(j.state)) return j;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error("job timed out");
}
const opts = (work, key, script, artifacts) => ({
  project: "p1",
  gate: "build",
  key,
  cwd: work,
  command: process.execPath,
  args: ["-e", script],
  timeoutMs: 5000,
  ...(artifacts === undefined ? {} : { artifacts }),
});
const WRITE =
  'require("fs").mkdirSync("out",{recursive:true});require("fs").writeFileSync("out/app.bin","v1")';

test("a successful job with artifacts records a verifiable receipt summary", async (t) => {
  const { work, runner } = fixture(t);
  const j = runner.run(opts(work, "a", WRITE, { include: ["out"] }));
  const done = await finished(runner, j.id);
  assert.equal(done.state, "succeeded");
  assert.equal(done.artifactReceiptError, undefined);
  const expected = await buildArtifactReceipt({ root: work, include: ["out"] });
  assert.deepEqual(done.artifactReceipt, {
    version: 1,
    include: ["out"],
    totalFiles: 1,
    totalBytes: 2,
    receiptSha256: expected.receiptSha256,
  });
  assert.ok(!JSON.stringify(done).includes(work), "no absolute path leaks");
});

test("a job without artifacts is unchanged and has no receipt fields", async (t) => {
  const { work, runner } = fixture(t);
  const j = runner.run(opts(work, "b", "1"));
  const done = await finished(runner, j.id);
  assert.equal(done.state, "succeeded");
  assert.equal("artifactReceipt" in done, false);
  assert.equal("artifactReceiptError" in done, false);
});

test("missing output is recorded as an error code and does not fail the job", async (t) => {
  const { work, runner } = fixture(t);
  const j = runner.run(opts(work, "c", "1", { include: ["nope"] }));
  const done = await finished(runner, j.id);
  assert.equal(done.state, "succeeded");
  assert.equal(done.exitCode, 0);
  assert.equal(done.artifactReceiptError, "ARTIFACT_NOT_FOUND");
  assert.equal("artifactReceipt" in done, false);
});

test("a failed job never gets a receipt", async (t) => {
  const { work, runner } = fixture(t);
  const j = runner.run(
    opts(work, "d", WRITE + ";process.exit(3)", { include: ["out"] }),
  );
  const done = await finished(runner, j.id);
  assert.equal(done.state, "failed");
  assert.equal("artifactReceipt" in done, false);
  assert.equal("artifactReceiptError" in done, false);
});

test("unsafe include entries are refused at submit time", (t) => {
  const { work, runner } = fixture(t);
  for (const bad of [
    {},
    { include: [] },
    { include: "out" },
    { include: [1] },
    { include: Array.from({ length: 65 }, (_, i) => `f${i}`) },
  ])
    assert.throws(
      () => runner.run(opts(work, "e" + Math.random(), "1", bad)),
      /INVALID_ARTIFACT_SPEC/,
    );
  // Syntactically valid but escaping entries are accepted here and recorded as
  // ARTIFACT_PATH_INVALID by the receipt builder, never read.
});

test("an escaping include is recorded as an error, not read", async (t) => {
  const { work, runner } = fixture(t);
  const j = runner.run(opts(work, "f", "1", { include: ["../x"] }));
  const done = await finished(runner, j.id);
  assert.equal(done.state, "succeeded");
  assert.equal(done.artifactReceiptError, "ARTIFACT_PATH_INVALID");
});

test("the artifact list is part of the idempotency fingerprint", (t) => {
  const { work, runner } = fixture(t);
  const a = runner.run(opts(work, "same", WRITE, { include: ["out"] }));
  const b = runner.run(opts(work, "same", WRITE, { include: ["out"] }));
  assert.equal(a.id, b.id);
  assert.throws(
    () => runner.run(opts(work, "same", WRITE, { include: ["other"] })),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () => runner.run(opts(work, "same", WRITE)),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("the receipt survives a journal reload", async (t) => {
  const { root, work, runner } = fixture(t);
  const j = runner.run(opts(work, "g", WRITE, { include: ["out"] }));
  const done = await finished(runner, j.id);
  const reload = new JobRunner(root);
  t.after(() => reload.close());
  assert.deepEqual(
    reload.get(j.id, "p1").artifactReceipt,
    done.artifactReceipt,
  );
});
