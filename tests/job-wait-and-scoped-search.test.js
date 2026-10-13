import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";
import { JobRunner } from "../src/jobs.js";
import { createDispatcher } from "../src/tools.js";

function fixture(t, gates = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wait-search-"));
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(
    path.join(root, "src", "a.js"),
    "const Needle = 1;\nneedle two\n",
  );
  fs.writeFileSync(path.join(root, "src", "b.ts"), "// needle in ts\n");
  fs.writeFileSync(path.join(root, "docs", "n.md"), "needle in docs\n");
  fs.writeFileSync(path.join(root, ".env"), "needle=secret\n");
  const runner = new JobRunner(path.join(base, "state", "jobs"), {
    maxConcurrent: 1,
  });
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      pollMs: 10,
      projects: [{ id: "p1", root, writable: true, gates, commands: {} }],
    },
    runner,
    () => ({ features: ["read", "execute"], limits: { concurrent_jobs: 1 } }),
  );
  return { root, files: new ProjectFiles(root), dispatch };
}

const scope = { device: "d1", project: "p1" };
const call = (dispatch, name, input) =>
  dispatch(name, { ...scope, ...input }, ["read", "execute"]);

test("search keeps its old behaviour without options", (t) => {
  const { files } = fixture(t);
  const r = files.search("needle");
  assert.deepEqual(r.matches.map((m) => `${m.path}:${m.line}`).sort(), [
    "docs/n.md:1",
    "src/a.js:2",
    "src/b.ts:1",
  ]);
  assert.equal(r.truncated, false);
});

test("search can be scoped by directory, extension, case and result count", (t) => {
  const { files } = fixture(t);
  assert.deepEqual(
    files
      .search("needle", { pathPrefix: "src" })
      .matches.map((m) => m.path)
      .sort(),
    ["src/a.js", "src/b.ts"],
  );
  assert.deepEqual(
    files.search("needle", { extensions: [".md"] }).matches.map((m) => m.path),
    ["docs/n.md"],
  );
  // Case-sensitive by default; opt in to insensitive matching.
  assert.equal(files.search("Needle").matches.length, 1);
  assert.equal(
    files.search("Needle", { caseSensitive: false }).matches.length,
    4,
  );
  const limited = files.search("needle", { maxResults: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
});

test("search options are validated and cannot escape the project or read secrets", (t) => {
  const { files } = fixture(t);
  for (const bad of [0, 101, 1.5, "5"])
    assert.throws(
      () => files.search("needle", { maxResults: bad }),
      /INVALID_SEARCH_LIMIT/,
    );
  assert.throws(
    () => files.search("needle", { caseSensitive: "yes" }),
    /INVALID_SEARCH_OPTION/,
  );
  for (const bad of [
    [],
    ["js"],
    ["../x"],
    [".a/b"],
    "md",
    new Array(11).fill(".js"),
  ])
    assert.throws(
      () => files.search("needle", { extensions: bad }),
      /INVALID_SEARCH_EXTENSIONS/,
    );
  for (const prefix of ["../", "/etc", "src/../..", "a\\b", "nope"])
    assert.throws(() => files.search("needle", { pathPrefix: prefix }));
  assert.throws(
    () => files.search("needle", { pathPrefix: ".env" }),
    /PATH_DENIED|INVALID_PATH/,
  );
  // The secret file is never searched, with or without options.
  assert.ok(!files.search("secret").matches.some((m) => m.path === ".env"));
});

test("search_code through the dispatcher honours options and redacts", async (t) => {
  const { dispatch, root } = fixture(t);
  fs.writeFileSync(
    path.join(root, "src", "c.js"),
    "needle token=abc123secret\n",
  );
  const r = await call(dispatch, "search_code", {
    query: "needle",
    pathPrefix: "src",
    extensions: [".js"],
    maxResults: 5,
  });
  assert.deepEqual(r.matches.map((m) => m.path).sort(), [
    "src/a.js",
    "src/c.js",
  ]);
  assert.ok(!JSON.stringify(r).includes("abc123secret"));
  await assert.rejects(
    call(dispatch, "search_code", { query: "needle", maxResults: 500 }),
  );
});

const slowGate = {
  slow: {
    command: process.execPath,
    args: ["-e", 'setTimeout(()=>console.log("A".repeat(300)+"DONE"),400)'],
    timeoutMs: 5000,
  },
};

test("get_job_status waitMs returns the finished job in one call", async (t) => {
  const { dispatch } = fixture(t, slowGate);
  const started = await call(dispatch, "run_quality_gate", {
    gate: "slow",
    requestKey: "wait-1",
  });
  const immediate = await call(dispatch, "get_job_status", { job: started.id });
  assert.ok(["queued", "running"].includes(immediate.state));
  const t0 = Date.now();
  const done = await call(dispatch, "get_job_status", {
    job: started.id,
    waitMs: 8000,
  });
  assert.equal(done.state, "succeeded");
  assert.match(done.output, /DONE/);
  assert.ok(
    Date.now() - t0 < 6000,
    "must return as soon as the job ends, not after waitMs",
  );
});

test("get_job_status waitMs is bounded and returns a still-running job after the wait", async (t) => {
  const { dispatch } = fixture(t, {
    long: {
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},4000)"],
      timeoutMs: 8000,
    },
  });
  const started = await call(dispatch, "run_quality_gate", {
    gate: "long",
    requestKey: "wait-2",
  });
  const t0 = Date.now();
  const still = await call(dispatch, "get_job_status", {
    job: started.id,
    waitMs: 300,
  });
  const elapsed = Date.now() - t0;
  assert.ok(["queued", "running"].includes(still.state));
  assert.ok(elapsed >= 250 && elapsed < 2500, `waited ${elapsed} ms`);
  await assert.rejects(
    call(dispatch, "get_job_status", { job: started.id, waitMs: 10001 }),
  );
  await assert.rejects(
    call(dispatch, "get_job_status", { job: started.id, waitMs: -1 }),
  );
  await call(dispatch, "cancel_job", { job: started.id }).catch(() => {});
});

test("get_job_status tailChars returns only the end of the log and says so", async (t) => {
  const { dispatch } = fixture(t, slowGate);
  const started = await call(dispatch, "run_quality_gate", {
    gate: "slow",
    requestKey: "tail-1",
  });
  const full = await call(dispatch, "get_job_status", {
    job: started.id,
    waitMs: 8000,
  });
  assert.equal(full.outputTailOnly, undefined);
  const tail = await call(dispatch, "get_job_status", {
    job: started.id,
    tailChars: 10,
  });
  assert.equal(tail.output.length, 10);
  assert.ok(tail.output.endsWith("DONE\n") || tail.output.endsWith("DONE"));
  assert.equal(tail.outputTailOnly, true);
  assert.equal(tail.outputChars, full.output.length);
  const none = await call(dispatch, "get_job_status", {
    job: started.id,
    tailChars: 0,
  });
  assert.equal(none.output, "");
  await assert.rejects(
    call(dispatch, "get_job_status", { job: started.id, tailChars: 8193 }),
  );
});

test("get_job_status still enforces project scope and read access", async (t) => {
  const { dispatch } = fixture(t, slowGate);
  const started = await call(dispatch, "run_quality_gate", {
    gate: "slow",
    requestKey: "scope-1",
  });
  await assert.rejects(
    dispatch(
      "get_job_status",
      { ...scope, project: "p2", job: started.id, waitMs: 100 },
      ["read"],
    ),
    /PROJECT_NOT_FOUND/,
  );
  await assert.rejects(
    dispatch("get_job_status", { ...scope, job: started.id, waitMs: 100 }, [
      "write",
    ]),
    /ACCESS_DENIED/,
  );
  await call(dispatch, "get_job_status", { job: started.id, waitMs: 8000 });
});

test("peekState is project scoped and many concurrent waits degrade to immediate answers", async (t) => {
  const { dispatch } = fixture(t, {
    long: {
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},3000)"],
      timeoutMs: 8000,
    },
  });
  const started = await call(dispatch, "run_quality_gate", {
    gate: "long",
    requestKey: "waiters-1",
  });
  // 24 simultaneous long waits: at most 16 may wait; the rest answer at once, all succeed.
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: 24 }, () =>
      call(dispatch, "get_job_status", { job: started.id, waitMs: 600 }),
    ),
  );
  assert.equal(results.length, 24);
  assert.ok(results.every((r) => ["queued", "running"].includes(r.state)));
  assert.ok(Date.now() - t0 < 3000);
  await call(dispatch, "cancel_job", { job: started.id }).catch(() => {});
  await assert.rejects(
    dispatch(
      "get_job_status",
      { ...scope, project: "p2", job: started.id, waitMs: 100 },
      ["read"],
    ),
    /PROJECT_NOT_FOUND/,
  );
});
