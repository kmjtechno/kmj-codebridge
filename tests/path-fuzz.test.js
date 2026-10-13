import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectFiles } from "../src/policy.js";

const CANARY = "OUTSIDE-CANARY-CONTENT";

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pathfuzz-"));
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "ok.txt"), "inside\n");
  const outside = path.join(base, "outside.txt");
  fs.writeFileSync(outside, CANARY);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, outside, files: new ProjectFiles(root) };
}

const HOSTILE = [
  "../outside.txt",
  "../../outside.txt",
  "src/../../outside.txt",
  "..\\outside.txt",
  "src\\..\\..\\outside.txt",
  "/etc/passwd",
  "\\\\server\\share\\x",
  "//server/share/x",
  "C:\\Windows\\win.ini",
  "C:/Windows/win.ini",
  "ok.txt\0.png",
  "src/ok.txt\0",
  "src/ok.txt:stream",
  "src/ok.txt::$DATA",
  "..%2foutside.txt",
  "%2e%2e/outside.txt",
  "CON",
  "src/NUL.txt",
  "src/ok.txt.",
  "src/ok.txt ",
  "a".repeat(5000),
  "src/" + "../".repeat(200) + "outside.txt",
  "\u202e/../outside.txt",
  "..\u2215outside.txt",
];

const READERS = {
  read: (f, p) => f.read(p),
  readTail: (f, p) => f.readTail(p, 5),
  readRange: (f, p) => f.readRange(p, 1, 5),
  fileInfo: (f, p) => f.fileInfo(p),
  list: (f, p) => f.list(p),
  tree: (f, p) => f.tree(p, 2, 20),
  integrityManifest: (f, p) => f.integrityManifest(p, 1, 10),
  search: (f, p) => f.search("OUTSIDE", { pathPrefix: p }),
  preview: (f, p) => f.preview(p, "x"),
};

const WRITERS = {
  write: (f, p) => f.write(p, "PWNED"),
  edit: (f, p) => f.edit(p, "a", "b"),
  createDirectory: (f, p) => f.createDirectory(p),
  moveFrom: (f, p) => f.moveFile(p, "src/moved.txt"),
  moveTo: (f, p) => f.moveFile("src/ok.txt", p),
  copyFrom: (f, p) => f.copyFile(p, "src/copied.txt"),
  copyTo: (f, p) => f.copyFile("src/ok.txt", p),
};

function leaks(value) {
  try {
    return JSON.stringify(value ?? null).includes(CANARY);
  } catch {
    return false;
  }
}

test("hostile paths never read data from outside the project root", (t) => {
  const { files } = setup(t);
  for (const [name, fn] of Object.entries(READERS)) {
    for (const p of HOSTILE) {
      let out;
      try {
        out = fn(files, p);
      } catch {
        continue; // rejection is the expected outcome
      }
      assert.equal(
        leaks(out),
        false,
        `${name} leaked outside data for ${JSON.stringify(p).slice(0, 60)}`,
      );
    }
  }
});

test("hostile paths never write, move or copy outside the project root", (t) => {
  const { base, root, outside, files } = setup(t);
  const before = fs.readdirSync(base).sort();
  for (const [name, fn] of Object.entries(WRITERS)) {
    for (const p of HOSTILE) {
      try {
        fn(files, p);
      } catch {
        // rejection expected
      }
    }
    assert.equal(
      fs.readFileSync(outside, "utf8"),
      CANARY,
      `${name} altered outside file`,
    );
  }
  assert.deepEqual(
    fs.readdirSync(base).sort(),
    before,
    "new entries appeared beside the project root",
  );
  assert.equal(
    fs.readFileSync(path.join(root, "src", "ok.txt"), "utf8") === "PWNED",
    false,
  );
});

test("symlinks inside the root that point outside are not followed", (t) => {
  const { root, base, outside, files } = setup(t);
  try {
    fs.symlinkSync(outside, path.join(root, "link.txt"));
    fs.symlinkSync(base, path.join(root, "linkdir"), "dir");
  } catch {
    t.skip("symlinks unsupported here");
    return;
  }
  for (const p of ["link.txt", "linkdir", "linkdir/outside.txt"]) {
    for (const [name, fn] of Object.entries(READERS)) {
      let out;
      try {
        out = fn(files, p);
      } catch {
        continue;
      }
      assert.equal(leaks(out), false, `${name} followed symlink ${p}`);
    }
  }
  for (const p of ["link.txt", "linkdir/outside.txt", "linkdir/new.txt"]) {
    try {
      files.write(p, "PWNED");
    } catch {
      // expected
    }
  }
  assert.equal(fs.readFileSync(outside, "utf8"), CANARY);
  assert.equal(fs.existsSync(path.join(base, "new.txt")), false);
});

test("a hard link to an outside file is not readable or writable", (t) => {
  const { root, outside, files } = setup(t);
  try {
    fs.linkSync(outside, path.join(root, "hard.txt"));
  } catch {
    t.skip("hard links unsupported here");
    return;
  }
  let out;
  try {
    out = files.read("hard.txt");
  } catch {
    out = null;
  }
  assert.equal(leaks(out), false, "hard link exposed outside content");
  try {
    files.write("hard.txt", "PWNED");
  } catch {
    // expected
  }
  assert.equal(fs.readFileSync(outside, "utf8"), CANARY);
});

test("search pathPrefix cannot escape the root", (t) => {
  const { files } = setup(t);
  for (const p of [
    "..",
    "../",
    "../project",
    "..\\",
    "/",
    "src/..",
    "src/../..",
  ]) {
    let out;
    try {
      out = files.search("OUTSIDE", { pathPrefix: p });
    } catch {
      continue;
    }
    assert.equal(leaks(out), false, `search leaked for prefix ${p}`);
  }
});
