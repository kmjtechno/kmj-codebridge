import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles, hash } from "../src/policy.js";
import { createDispatcher } from "../src/tools.js";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-integrity-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, ".ssh"));
  fs.writeFileSync(path.join(root, "README.md"), "visible\n");
  fs.writeFileSync(path.join(root, "src", "main.ts"), "line1\r\nline2\r\n");
  fs.writeFileSync(path.join(root, "src", "binary.bin"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(root, "src", "big.txt"), "x".repeat(262145));
  fs.writeFileSync(path.join(root, ".env"), "token=secret\n");
  fs.writeFileSync(path.join(root, "node_modules", "hidden.js"), "private");
  fs.writeFileSync(path.join(root, ".ssh", "config"), "private");
  fs.symlinkSync(path.join(root, "src"), path.join(root, "linked"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { root, base, files: new ProjectFiles(root) };
}

test("manifest hashes readable files with exact original byte hashes, no content", (t) => {
  const { files } = fixture(t);
  const a = files.integrityManifest("", 2, 40);
  const b = files.integrityManifest("", 2, 40);
  assert.deepEqual(a, b);
  assert.equal(a.truncated, false);
  assert.equal(a.coverage, "bounded");
  const readme = a.entries.find((e) => e.path === "README.md");
  const main = a.entries.find((e) => e.path === "src/main.ts");
  assert.equal(readme.sha256, hash("visible\n"));
  assert.equal(main.sha256, hash("line1\r\nline2\r\n"));
  assert.equal(main.bytes, 14);
  assert.equal(a.bytesHashed, 22);
  assert.match(a.snapshotSha256, /^[a-f0-9]{64}$/);
  const json = JSON.stringify(a);
  assert.ok(!json.includes("line1"));
  assert.ok(!json.includes("token=secret"));
  assert.ok(!json.includes("node_modules"));
  assert.ok(!json.includes(".env"));
  assert.ok(!json.includes(".ssh"));
  assert.ok(!json.includes("linked"));
});

test("manifest explicitly distinguishes oversized and non-text files", (t) => {
  const { files } = fixture(t);
  const r = files.integrityManifest("src", 0, 40);
  assert.equal(r.entries.find((e) => e.path === "src/big.txt").status, "too_large");
  assert.equal(r.entries.find((e) => e.path === "src/binary.bin").status, "non_text");
  assert.equal(r.entries.find((e) => e.path === "src/binary.bin").sha256, null);
  assert.equal(r.entries.find((e) => e.path === "src/big.txt").sha256, null);
});

test("manifest truncation never pretends to be a full repository verification", (t) => {
  const { files } = fixture(t);
  const r = files.integrityManifest("src", 0, 1);
  assert.equal(r.files, 1);
  assert.equal(r.truncated, true);
  assert.equal(r.coverage, "partial");
  assert.throws(() => files.integrityManifest("", 6, 20), /INVALID_MANIFEST_LIMIT/);
  assert.throws(() => files.integrityManifest("", 1, 61), /INVALID_MANIFEST_LIMIT/);
  assert.throws(() => files.integrityManifest("../", 1, 5), /INVALID_PATH/);
  assert.throws(() => files.integrityManifest(".ssh", 1, 5), /INVALID_PATH/);
});

test("manifest rejects hard-linked sources instead of leaking across boundaries", (t) => {
  const { root, files } = fixture(t);
  fs.linkSync(path.join(root, "README.md"), path.join(root, "copy-linked.md"));
  assert.throws(() => files.integrityManifest("", 1, 40), /HARDLINK_DENIED/);
});

test("manifest requires read grant, respects device/project tenant scope", async (t) => {
  const { root, base } = fixture(t);
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({
      features: ["read"],
      limits: { concurrent_jobs: 1 },
    }),
  );
  const scoped = { device: "d1", project: "p1" };
  const r = await dispatch(
    "project_integrity_manifest",
    { ...scoped, maxDepth: 2, maxFiles: 40 },
    ["read"],
  );
  assert.ok(r.entries.some((e) => e.path === "src/main.ts"));
  await assert.rejects(
    dispatch("project_integrity_manifest", scoped, ["write"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("project_integrity_manifest", { ...scoped, device: "d2" }, ["read"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("project_integrity_manifest", { ...scoped, project: "p2" }, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
});
