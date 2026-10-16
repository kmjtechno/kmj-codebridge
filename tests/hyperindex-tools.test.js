import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-hyper-tools-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project"),
    stateDir = path.join(base, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "a.js"), "needle\n");
  const dispatch = createDispatcher(
    {
      id: "d",
      stateDir,
      projects: [{ id: "p", root, writable: true, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({ features: ["read", "execute"], limits: { concurrent_jobs: 1 } }),
  );
  return {
    root,
    stateDir,
    call: (name, args = {}, permissions = ["read", "execute"]) =>
      dispatch(name, { device: "d", project: "p", ...args }, permissions),
  };
}
test("missing index search falls back without creating state; unauthorized build is refused", async (t) => {
  const f = setup(t);
  const status = await f.call("hyperindex_status");
  assert.equal(status.state, "missing");
  const r = await f.call("hyperindex_search", { query: "needle" });
  assert.equal(r.fallback, true);
  assert.equal(r.matches[0].line, 1);
  assert.deepEqual(fs.readdirSync(f.stateDir), []);
  await assert.rejects(f.call("hyperindex_build", {}, ["read"]));
  await assert.rejects(
    f.call("hyperindex_search", { query: "needle", project: "other" }),
  );
});
test(
  "explicit build and search reconcile changes; corrupt index falls back safely",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = setup(t);
    const b = await f.call("hyperindex_build");
    assert.equal(b.built, true);
    let r = await f.call("hyperindex_search", { query: "needle" });
    assert.equal(r.fallback, false);
    fs.writeFileSync(path.join(f.root, "a.js"), "replacement\n");
    assert.equal(
      (await f.call("hyperindex_search", { query: "needle" })).matches.length,
      0,
    );
    const db = path.join(
      f.stateDir,
      "hyperindex",
      fs.readdirSync(path.join(f.stateDir, "hyperindex"))[0],
      "hyperindex.sqlite",
    );
    fs.writeFileSync(db, "corrupt");
    r = await f.call("hyperindex_search", { query: "replacement" });
    assert.equal(r.fallback, true);
    assert.equal(r.matches.length, 1);
  },
);
test("fallback redacts multiline key bodies without losing benign original lines", async (t) => {
  const f = setup(t);
  fs.writeFileSync(
    path.join(f.root, "a.js"),
    [
      "-----BEGIN " + "RSA PRIVATE KEY-----",
      "needle",
      "-----END " + "RSA PRIVATE KEY-----",
      "needle",
    ].join("\n"),
  );
  const r = await f.call("hyperindex_search", { query: "needle" });
  assert.deepEqual(
    r.matches.map((m) => m.line),
    [4],
  );
});
test(
  "untrusted index state cannot redirect writes or prevent authorized lexical fallback",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = setup(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cb-hyper-outside-"));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.symlinkSync(outside, path.join(f.stateDir, "hyperindex"));
    await assert.rejects(f.call("hyperindex_build"), /INDEX_STATE_UNSAFE/);
    assert.equal((await f.call("hyperindex_status")).state, "unavailable");
    const result = await f.call("hyperindex_search", { query: "needle" });
    assert.equal(result.fallback, true);
    assert.equal(result.matches.length, 1);
    assert.deepEqual(fs.readdirSync(outside), []);
  },
);
