import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestSignedRelease } from "../scripts/latest-signed-release.mjs";

const sha = (c) => c.repeat(40);
function tree(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
  for (const [dir, manifest] of entries) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(
      path.join(root, dir, "release-manifest.json"),
      JSON.stringify(manifest),
    );
  }
  return root;
}

test("highest sequence wins regardless of directory order", () => {
  const root = tree([
    [sha("a"), { sequence: 23, revision: sha("a") }],
    [sha("b"), { sequence: 24, revision: sha("b") }],
    [sha("0"), { sequence: 9, revision: sha("0") }],
  ]);
  assert.deepEqual(latestSignedRelease(root), {
    sequence: 24,
    revision: sha("b"),
  });
});

test("fails closed on revision/dir mismatch, duplicate sequence, none found", () => {
  assert.throws(
    () =>
      latestSignedRelease(
        tree([[sha("a"), { sequence: 1, revision: sha("b") }]]),
      ),
    /RELEASE_REVISION_DIR_MISMATCH/,
  );
  assert.throws(
    () =>
      latestSignedRelease(
        tree([
          [sha("a"), { sequence: 5, revision: sha("a") }],
          [sha("b"), { sequence: 5, revision: sha("b") }],
        ]),
      ),
    /RELEASE_SEQUENCE_DUPLICATE/,
  );
  assert.throws(() => latestSignedRelease(tree([])), /RELEASE_NONE_FOUND/);
});

test("real repository resolves to a 40-hex revision", () => {
  const r = latestSignedRelease();
  assert.match(r.revision, /^[0-9a-f]{40}$/);
  assert.ok(r.sequence >= 24);
});
