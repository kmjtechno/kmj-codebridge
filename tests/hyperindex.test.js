import nodeTest from "node:test";
const test = (name, fn) =>
  nodeTest(
    name,
    {
      skip:
        process.platform === "win32"
          ? "Persistent index awaits Windows ACL verification"
          : false,
    },
    fn,
  );
nodeTest(
  "Windows index fails closed until private ACL verification exists",
  { skip: process.platform !== "win32" },
  () => {
    assert.throws(
      () => new HyperIndex(null, null),
      /INDEX_WINDOWS_ACL_UNVERIFIED/,
    );
  },
);
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";
import { HyperIndex } from "../src/hyperindex.js";
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-hyper-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  const state = path.join(base, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(state, { mode: 0o700 });
  return { root, state, files: new ProjectFiles(root) };
}
test("persistent index synchronizes additions, changes and deletions without stale snippets", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "a.js"), "const alpha = 1;\n");
  let index = new HyperIndex(f.files, f.state);
  assert.equal(index.search("alpha").matches.length, 1);
  assert.equal(index.refresh().updated, 0);
  index.close();
  index = new HyperIndex(f.files, f.state);
  t.after(() => index.close());
  fs.writeFileSync(path.join(f.root, "a.js"), "const beta = 2;\n");
  fs.writeFileSync(path.join(f.root, "b.js"), "alpha\n");
  assert.deepEqual(
    index.search("alpha").matches.map((x) => x.path),
    ["b.js"],
  );
  fs.unlinkSync(path.join(f.root, "b.js"));
  assert.equal(index.search("alpha").matches.length, 0);
});
test("policy excludes credentials, hardlinks and symlinks and scopes stored index identity", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, ".env"), "needle");
  fs.writeFileSync(path.join(f.root, "ok.js"), "needle");
  fs.linkSync(path.join(f.root, "ok.js"), path.join(f.root, "hard.js"));
  fs.symlinkSync("/etc/passwd", path.join(f.root, "escape"));
  const index = new HyperIndex(f.files, f.state);
  assert.equal(index.search("needle").matches.length, 0);
  index.close();
  const other = path.join(path.dirname(f.root), "other");
  fs.mkdirSync(other);
  assert.throws(
    () => new HyperIndex(new ProjectFiles(other), f.state),
    /INDEX_PROJECT_MISMATCH/,
  );
});
test("bounded coverage and limits are explicit; short substring search retains correctness", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "a.js"), "aaa\naaa\n");
  const index = new HyperIndex(f.files, f.state);
  t.after(() => index.close());
  const result = index.search("aa", { maxResults: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.freshness, "reconciled");
  assert.throws(
    () => index.search("x", { maxResults: 101 }),
    /INVALID_SEARCH_LIMIT/,
  );
});
test("unsafe index paths fail closed", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, "hyperindex.sqlite"), "bad", {
    mode: 0o644,
  });
  assert.throws(() => new HyperIndex(f.files, f.state), /INDEX_FILE_UNSAFE/);
});
test("indexed literal matching preserves punctuation, case, unicode and whitespace", (t) => {
  const f = fixture(t);
  const content =
    'Alpha beta\na.b[c] \"quoted\"\nनमस्ते दुनिया\nline\twith tabs\n';
  fs.writeFileSync(path.join(f.root, "a.js"), content);
  const index = new HyperIndex(f.files, f.state);
  t.after(() => index.close());
  for (const query of [
    "Alpha",
    "alpha",
    "a.b",
    "b[c]",
    '"quoted"',
    "नमस्ते",
    "with tabs",
    "line\twith",
  ])
    assert.deepEqual(
      index.search(query).matches,
      f.files.search(query).matches,
      query,
    );
});
test("recognized credentials are not persisted or returned", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.root, "config.js"),
    'const password = "my-private-password-123";',
  );
  const index = new HyperIndex(f.files, f.state);
  t.after(() => index.close());
  index.search("password");
  assert.equal(index.search("my-private-password-123").matches.length, 0);
  assert.ok(
    !JSON.stringify(
      index.db.prepare("SELECT content FROM files").all(),
    ).includes("my-private-password-123"),
  );
});
test("equivalent project root paths cannot hold index state", (t) => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o700);
  for (const dir of [f.root, f.root + "/.", f.root + "/"])
    assert.throws(
      () => new HyperIndex(f.files, dir),
      /INDEX_STATE_INSIDE_PROJECT/,
    );
});
test("private key redaction preserves original line numbers and excludes key body", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.root, "fixture.txt"),
    [
      "before",
      "-----BEGIN " + "RSA PRIVATE KEY-----",
      "private-body",
      "-----END " + "RSA PRIVATE KEY-----",
      "needle",
      "",
    ].join("\n"),
  );
  const index = new HyperIndex(f.files, f.state);
  t.after(() => index.close());
  assert.equal(index.search("needle").matches[0].line, 5);
  assert.equal(index.search("private-body").matches.length, 0);
});
