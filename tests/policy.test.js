import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "hello.txt"), "hello\nworld\n");
  return { root, files: new ProjectFiles(root) };
}
test("reads bounded text and returns content hash", (t) => {
  const { files } = fixture(t);
  const r = files.read("hello.txt");
  assert.equal(r.content, "hello\nworld\n");
  assert.match(r.sha256, /^[a-f0-9]{64}$/);
});
for (const p of [
  "../outside",
  "/etc/passwd",
  "a/../../outside",
  "C:\\Windows\\system.ini",
  "a\\..\\secret",
])
  test("rejects unsafe path " + p, (t) => {
    const { files } = fixture(t);
    assert.throws(() => files.read(p), /PATH/);
  });
for (const p of [
  ".env",
  ".env.local",
  ".git/config",
  "key.pem",
  "id_rsa",
  "credentials.json",
  "token.txt",
])
  test("rejects sensitive path " + p, (t) => {
    const { root, files } = fixture(t);
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), "private");
    assert.throws(() => files.read(p), /DENIED/);
  });
test("rejects symlink files", (t) => {
  const { root, files } = fixture(t);
  fs.symlinkSync(path.join(root, "hello.txt"), path.join(root, "link"));
  assert.throws(() => files.read("link"), /SYMLINK/);
});
test("rejects symlink parents", (t) => {
  const { root, files } = fixture(t);
  fs.mkdirSync(path.join(root, "dir"));
  fs.symlinkSync(path.join(root, "dir"), path.join(root, "alias"));
  assert.throws(() => files.write("alias/file", "x", null), /SYMLINK/);
});
test("preview has no side effect; stale patch cannot overwrite", (t) => {
  const { root, files } = fixture(t);
  const before = files.read("hello.txt");
  assert.equal(
    files.preview("hello.txt", "updated", before.sha256).changed,
    true,
  );
  assert.equal(files.read("hello.txt").content, before.content);
  fs.writeFileSync(path.join(root, "hello.txt"), "someone else");
  assert.throws(
    () => files.write("hello.txt", "mine", before.sha256),
    /CONFLICT/,
  );
  assert.equal(files.read("hello.txt").content, "someone else");
});
test("write requires expected hash and supports explicit create", (t) => {
  const { files } = fixture(t);
  assert.throws(() => files.write("hello.txt", "oops", null), /CONFLICT/);
  const r = files.write("new.txt", "new", null);
  assert.equal(files.read("new.txt").sha256, r.sha256);
  const old = files.read("hello.txt");
  files.write("hello.txt", "safe", old.sha256);
  assert.equal(files.read("hello.txt").content, "safe");
});
test("rejects oversized and binary files", (t) => {
  const { root, files } = fixture(t);
  fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(262145));
  assert.throws(() => files.read("big.txt"), /TOO_LARGE/);
  fs.writeFileSync(path.join(root, "binary"), Buffer.from([0, 255]));
  assert.throws(() => files.read("binary"), /BINARY/);
});
test("search excludes secrets and reports line matches", (t) => {
  const { root, files } = fixture(t);
  fs.writeFileSync(path.join(root, ".env"), "hello secret");
  const r = files.search("hello");
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].path, "hello.txt");
  assert.equal(r.matches[0].line, 1);
});
test("hardlinked files cannot be read or replaced", (t) => {
  const { root, files } = fixture(t);
  fs.linkSync(path.join(root, "hello.txt"), path.join(root, "hard"));
  assert.throws(() => files.read("hard"), /HARDLINK/);
});
