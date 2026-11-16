import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  ARTIFACT_RECEIPT_LIMITS,
  ARTIFACT_RECEIPT_VERSION,
  ArtifactReceiptError,
  buildArtifactReceipt,
  verifyArtifactReceipt,
} from "../src/artifact-receipt.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "out", "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "out", "app.bin"), "binary-1");
  fs.writeFileSync(path.join(root, "out", "sub", "lib.dll"), "library-1");
  fs.writeFileSync(path.join(root, "notes.txt"), "not part of the artifact");
  return root;
}

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ArtifactReceiptError, String(error));
    return error.code;
  }
  assert.fail("expected ArtifactReceiptError");
};

test("receipt lists every file under the include list with exact hashes", async (t) => {
  const root = tree(t);
  const receipt = await buildArtifactReceipt({ root, include: ["out"] });
  assert.equal(receipt.version, ARTIFACT_RECEIPT_VERSION);
  assert.equal(receipt.algorithm, "sha256");
  assert.deepEqual(receipt.files, [
    { path: "out/app.bin", size: 8, sha256: sha("binary-1") },
    { path: "out/sub/lib.dll", size: 9, sha256: sha("library-1") },
  ]);
  assert.equal(receipt.totalFiles, 2);
  assert.equal(receipt.totalBytes, 17);
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(receipt).includes(root), "no absolute path leaks");
});

test("the receipt hash is deterministic and ignores include order, duplicates and separators", async (t) => {
  const root = tree(t);
  const a = await buildArtifactReceipt({
    root,
    include: ["out/sub", "out/app.bin"],
  });
  const b = await buildArtifactReceipt({
    root,
    include: ["out\\app.bin", "out/sub", "out/sub", "out/app.bin"],
  });
  assert.equal(a.receiptSha256, b.receiptSha256);
  assert.deepEqual(b.include, ["out/app.bin", "out/sub"]);
  assert.deepEqual(
    b.files.map((f) => f.path),
    ["out/app.bin", "out/sub/lib.dll"],
  );
  // A different include list is a different claim, even over the same files.
  const whole = await buildArtifactReceipt({ root, include: ["out"] });
  assert.deepEqual(whole.files, b.files);
  assert.notEqual(whole.receiptSha256, a.receiptSha256);
  const only = await buildArtifactReceipt({ root, include: ["out/app.bin"] });
  assert.equal(only.totalFiles, 1);
});

test("changing content, size, adding or removing a file changes the receipt", async (t) => {
  const root = tree(t);
  const base = await buildArtifactReceipt({ root, include: ["out"] });
  fs.writeFileSync(path.join(root, "out", "app.bin"), "binary-2");
  const changed = await buildArtifactReceipt({ root, include: ["out"] });
  assert.notEqual(changed.receiptSha256, base.receiptSha256);
  fs.writeFileSync(path.join(root, "out", "extra.txt"), "x");
  const added = await buildArtifactReceipt({ root, include: ["out"] });
  assert.notEqual(added.receiptSha256, changed.receiptSha256);
  fs.rmSync(path.join(root, "out", "extra.txt"));
  fs.rmSync(path.join(root, "out", "sub", "lib.dll"));
  const removed = await buildArtifactReceipt({ root, include: ["out"] });
  assert.equal(removed.totalFiles, 1);
});

test("unsafe include paths are refused before anything is read", async (t) => {
  const root = tree(t);
  for (const bad of [
    "",
    "..",
    "../x",
    "out/../notes.txt",
    "out\\..\\notes.txt",
    "/etc/passwd",
    "C:\\Windows",
    "C:evil",
    "out/",
    "out//app.bin",
    "out/./app.bin",
    "out/app.bin ",
    "out/app.bin.",
    "out/a:stream",
    "out/*",
    "out/a\u0000b",
    "out/a\nb",
    "x".repeat(ARTIFACT_RECEIPT_LIMITS.maxPathLength + 1),
    42,
    null,
  ])
    assert.equal(
      await code(buildArtifactReceipt({ root, include: [bad] })),
      "ARTIFACT_PATH_INVALID",
      JSON.stringify(bad),
    );
});

test("root and include arguments are required and validated", async (t) => {
  const root = tree(t);
  assert.equal(
    await code(buildArtifactReceipt({ include: ["out"] })),
    "ARTIFACT_ROOT_INVALID",
  );
  assert.equal(
    await code(
      buildArtifactReceipt({ root: "relative/dir", include: ["out"] }),
    ),
    "ARTIFACT_ROOT_INVALID",
  );
  assert.equal(
    await code(
      buildArtifactReceipt({
        root: path.join(root, "missing"),
        include: ["out"],
      }),
    ),
    "ARTIFACT_ROOT_INVALID",
  );
  assert.equal(
    await code(
      buildArtifactReceipt({
        root: path.join(root, "notes.txt"),
        include: ["out"],
      }),
    ),
    "ARTIFACT_ROOT_INVALID",
  );
  assert.equal(
    await code(buildArtifactReceipt({ root })),
    "ARTIFACT_INCLUDE_REQUIRED",
  );
  assert.equal(
    await code(buildArtifactReceipt({ root, include: [] })),
    "ARTIFACT_INCLUDE_REQUIRED",
  );
  assert.equal(
    await code(
      buildArtifactReceipt({
        root,
        include: Array.from({ length: 65 }, (_, i) => `f${i}`),
      }),
    ),
    "ARTIFACT_INCLUDE_TOO_LONG",
  );
  assert.equal(
    await code(buildArtifactReceipt({ root, include: ["nope"] })),
    "ARTIFACT_NOT_FOUND",
  );
});

test("symlinks are refused as the entry, inside a directory and as a parent", async (t) => {
  const root = tree(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  try {
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(root, "out", "link.txt"),
    );
    fs.symlinkSync(outside, path.join(root, "linkdir"));
  } catch {
    t.skip("symlinks not permitted here");
    return;
  }
  assert.equal(
    await code(buildArtifactReceipt({ root, include: ["out/link.txt"] })),
    "ARTIFACT_SYMLINK_REFUSED",
  );
  assert.equal(
    await code(buildArtifactReceipt({ root, include: ["out"] })),
    "ARTIFACT_SYMLINK_REFUSED",
  );
  assert.equal(
    await code(buildArtifactReceipt({ root, include: ["linkdir/secret.txt"] })),
    "ARTIFACT_OUTSIDE_ROOT",
  );
  fs.symlinkSync(root, path.join(os.tmpdir(), `kmj-rootlink-${process.pid}`));
  const rootLink = path.join(os.tmpdir(), `kmj-rootlink-${process.pid}`);
  t.after(() => fs.rmSync(rootLink, { force: true }));
  assert.equal(
    await code(buildArtifactReceipt({ root: rootLink, include: ["out"] })),
    "ARTIFACT_ROOT_INVALID",
  );
});

test("non-regular files such as FIFOs are refused", async (t) => {
  if (process.platform === "win32") return t.skip("no mkfifo");
  const root = tree(t);
  const made = spawnSync("mkfifo", [path.join(root, "out", "pipe")]);
  if (made.status !== 0) return t.skip("mkfifo unavailable");
  assert.equal(
    await code(buildArtifactReceipt({ root, include: ["out"] })),
    "ARTIFACT_NOT_REGULAR",
  );
});

test("limits are enforced and can only be lowered, never raised", async (t) => {
  const root = tree(t);
  assert.equal(
    await code(
      buildArtifactReceipt({ root, include: ["out"], limits: { maxFiles: 1 } }),
    ),
    "ARTIFACT_TOO_MANY_FILES",
  );
  assert.equal(
    await code(
      buildArtifactReceipt({
        root,
        include: ["out"],
        limits: { maxFileBytes: 8 },
      }),
    ),
    "ARTIFACT_FILE_TOO_LARGE",
  );
  assert.equal(
    await code(
      buildArtifactReceipt({
        root,
        include: ["out"],
        limits: { maxTotalBytes: 16 },
      }),
    ),
    "ARTIFACT_TOTAL_TOO_LARGE",
  );
  assert.equal(
    await code(
      buildArtifactReceipt({
        root,
        include: ["out/sub/lib.dll"],
        limits: { maxDepth: 2 },
      }),
    ),
    "ARTIFACT_TOO_DEEP",
  );
  assert.equal(
    await code(
      buildArtifactReceipt({ root, include: ["out"], limits: { maxFiles: 0 } }),
    ),
    "ARTIFACT_LIMIT_INVALID",
  );
  assert.equal(
    await code(
      buildArtifactReceipt({
        root,
        include: ["out"],
        limits: { maxFiles: 1.5 },
      }),
    ),
    "ARTIFACT_LIMIT_INVALID",
  );
  const raised = await buildArtifactReceipt({
    root,
    include: ["out"],
    limits: { maxFiles: 10 ** 9, maxTotalBytes: 2 ** 50 },
  });
  assert.equal(raised.totalFiles, 2);
  assert.ok(Object.isFrozen(ARTIFACT_RECEIPT_LIMITS));
  // A directory with no files yields no vacuous receipt.
  fs.mkdirSync(path.join(root, "empty"));
  assert.equal(
    await code(buildArtifactReceipt({ root, include: ["empty"] })),
    "ARTIFACT_EMPTY",
  );
});

test("verify accepts an untouched tree and names modified, missing and added files", async (t) => {
  const root = tree(t);
  const receipt = await buildArtifactReceipt({ root, include: ["out"] });
  assert.deepEqual(await verifyArtifactReceipt(receipt, { root }), {
    ok: true,
    reason: null,
    modified: [],
    missing: [],
    added: [],
  });
  fs.writeFileSync(path.join(root, "out", "app.bin"), "tampered");
  fs.rmSync(path.join(root, "out", "sub", "lib.dll"));
  fs.writeFileSync(path.join(root, "out", "new.bin"), "n");
  const result = await verifyArtifactReceipt(receipt, { root });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ARTIFACT_MISMATCH");
  assert.deepEqual(result.modified, ["out/app.bin"]);
  assert.deepEqual(result.missing, ["out/sub/lib.dll"]);
  assert.deepEqual(result.added, ["out/new.bin"]);
});

test("verify rejects malformed or self-tampered receipts and reports unsafe trees", async (t) => {
  const root = tree(t);
  const receipt = await buildArtifactReceipt({ root, include: ["out"] });
  for (const bad of [
    null,
    {},
    { ...receipt, version: 2 },
    { ...receipt, algorithm: "md5" },
    { ...receipt, receiptSha256: "x" },
    { ...receipt, files: "no" },
  ])
    assert.equal(
      (await verifyArtifactReceipt(bad, { root })).reason,
      "RECEIPT_MALFORMED",
    );
  const forged = structuredClone(receipt);
  forged.files[0].sha256 = sha("something else");
  assert.equal(
    (await verifyArtifactReceipt(forged, { root })).reason,
    "RECEIPT_SELF_HASH_MISMATCH",
  );
  // A receipt that was re-hashed by an attacker still has to match the tree.
  const body = {
    version: 1,
    algorithm: "sha256",
    include: forged.include,
    files: forged.files,
  };
  forged.receiptSha256 = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  const forgedResult = await verifyArtifactReceipt(forged, { root });
  assert.equal(forgedResult.ok, false);
  assert.deepEqual(forgedResult.modified, ["out/app.bin"]);
  // An include list that escapes the root is reported, not thrown.
  const escaping = structuredClone(receipt);
  escaping.include = ["../x"];
  const eBody = {
    version: 1,
    algorithm: "sha256",
    include: escaping.include,
    files: escaping.files,
  };
  escaping.receiptSha256 = createHash("sha256")
    .update(JSON.stringify(eBody))
    .digest("hex");
  assert.equal(
    (await verifyArtifactReceipt(escaping, { root })).reason,
    "ARTIFACT_PATH_INVALID",
  );
});

test("the module is source-only: nothing in src imports it yet", () => {
  const importers = fs
    .readdirSync("src")
    .filter((f) => f.endsWith(".js") && f !== "artifact-receipt.js")
    .filter((f) =>
      /artifact-receipt/.test(fs.readFileSync(path.join("src", f), "utf8")),
    );
  assert.deepEqual(importers, []);
});
