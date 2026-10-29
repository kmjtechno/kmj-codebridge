import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-search-eacces-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "storage", "private"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "const needle = 1;\n");
  fs.writeFileSync(path.join(root, "storage", "private", "x.txt"), "needle\n");
  return root;
}

// Simulate a service-owned 0700 folder; root-run test hosts ignore real modes.
function denyDirectory(t, target, code = "EACCES") {
  const original = fs.readdirSync;
  return t.mock.method(fs, "readdirSync", (dir, ...rest) => {
    if (path.resolve(String(dir)) === target) {
      const error = new Error(`${code}: permission denied`);
      error.code = code;
      throw error;
    }
    return original.call(fs, dir, ...rest);
  });
}

test("an unreadable nested directory is skipped instead of failing the search", (t) => {
  const root = project(t);
  const files = new ProjectFiles(root);
  const mock = denyDirectory(
    t,
    path.join(fs.realpathSync(root), "storage", "private"),
  );
  const result = files.search("needle");
  mock.mock.restore();
  assert.deepEqual(
    result.matches.map((m) => m.path),
    ["src/a.js"],
  );
  assert.equal(result.unreadableDirectories, 1);
  assert.equal(result.truncated, true);
});

test("readable projects keep the original result shape", (t) => {
  const root = project(t);
  const result = new ProjectFiles(root).search("needle");
  assert.equal(result.matches.length, 2);
  assert.equal("unreadableDirectories" in result, false);
});

test("an unreadable scoped root still fails closed", (t) => {
  const root = project(t);
  const files = new ProjectFiles(root);
  const mock = denyDirectory(t, path.join(fs.realpathSync(root), "src"));
  assert.throws(() => files.search("needle", { pathPrefix: "src" }));
  mock.mock.restore();
});

test("unexpected filesystem errors are not silently swallowed", (t) => {
  const root = project(t);
  const files = new ProjectFiles(root);
  const mock = denyDirectory(
    t,
    path.join(fs.realpathSync(root), "storage"),
    "EIO",
  );
  assert.throws(() => files.search("needle"), /EIO/);
  mock.mock.restore();
});
