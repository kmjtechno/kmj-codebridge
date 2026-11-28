import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";
import { batchHyperSearch } from "../src/hyperindex-batch.js";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-batch-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, files: new ProjectFiles(root) };
}

test("six terms share one traversal, each file read once, fresh on next call", (t) => {
  const { root, files } = setup(t);
  fs.writeFileSync(path.join(root, "a.js"), "alpha beta gamma\n");
  fs.writeFileSync(path.join(root, "b.js"), "delta epsilon zeta\n");
  const queries = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const reads = [];
  const original = files.read.bind(files);
  files.read = (name) => {
    reads.push(name);
    return original(name);
  };
  const result = batchHyperSearch(files, queries);
  assert.equal(result.coverage.scans, 1);
  assert.equal(result.coverage.filesRead, 2);
  assert.equal(result.persistentIndexUsed, false);
  assert.equal(result.truncated, false);
  assert.deepEqual(reads.sort(), ["a.js", "b.js"]);
  assert.deepEqual(
    result.results.map((row) => row.matches.length),
    [1, 1, 1, 1, 1, 1],
  );
  fs.writeFileSync(path.join(root, "a.js"), "replacement\n");
  fs.unlinkSync(path.join(root, "b.js"));
  const next = batchHyperSearch(files, ["alpha", "replacement"]);
  assert.equal(next.results[0].matches.length, 0);
  assert.equal(next.results[1].matches.length, 1);
});

test("bounded live search excludes denied files and multiline key contents", (t) => {
  const { root, files } = setup(t);
  fs.writeFileSync(path.join(root, ".env"), "private-needle");
  fs.writeFileSync(
    path.join(root, "a.txt"),
    [
      "-----BEGIN " + "RSA PRIVATE KEY-----",
      "private-needle",
      "-----END " + "RSA PRIVATE KEY-----",
      "public-needle",
    ].join("\n"),
  );
  const result = batchHyperSearch(files, ["private-needle", "public-needle"]);
  assert.deepEqual(result.results[0].matches, []);
  assert.equal(result.results[1].matches[0].line, 4);
  assert.equal(JSON.stringify(result).includes("private-needle"), false);
});

test("duplicates and oversized requests fail; partial result is explicit", (t) => {
  const { root, files } = setup(t);
  fs.writeFileSync(path.join(root, "a.js"), "alpha\nalpha\nbeta\n");
  assert.throws(
    () => batchHyperSearch(files, ["alpha", "alpha"]),
    /INVALID_BATCH_QUERY/,
  );
  assert.throws(
    () => batchHyperSearch(files, ["alpha", "beta"], { maxResults: 17 }),
    /INVALID_BATCH_SEARCH_LIMIT/,
  );
  const result = batchHyperSearch(files, ["alpha", "beta"], { maxResults: 1 });
  assert.equal(result.results[0].truncated, true);
  assert.equal(result.results[1].truncated, true);
  assert.equal(result.truncated, true);
});
