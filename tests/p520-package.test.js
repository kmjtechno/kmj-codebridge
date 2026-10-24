import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const expected = [
  "START-KMJ-CALIBRATION-IDE.cmd",
  "BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1",
  "READ-ME-FIRST.txt",
];
const builder = path.resolve("scripts/package-p520-ide.js");

test("reviewed complete P520 IDE ZIP includes CMD, PS1 and README together", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-p520-zip-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, "installer.zip");
  const result = spawnSync(process.execPath, [builder, "--out", output], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /P520_IDE_PACKAGE=COMPLETE/);
  assert.match(result.stdout, /BOOTSTRAP_SHA256=PASS/);
  const archive = fs.readFileSync(output);
  const observed = [];
  let cursor = 0;
  for (const expectedName of expected) {
    assert.equal(archive.readUInt32LE(cursor), 0x04034b50);
    assert.equal(archive.readUInt16LE(cursor + 8), 0);
    const length = archive.readUInt32LE(cursor + 18);
    const nameLength = archive.readUInt16LE(cursor + 26);
    const extraLength = archive.readUInt16LE(cursor + 28);
    const name = archive
      .subarray(cursor + 30, cursor + 30 + nameLength)
      .toString("ascii");
    assert.equal(name, expectedName);
    observed.push(name);
    const start = cursor + 30 + nameLength + extraLength;
    const payload = archive.subarray(start, start + length);
    assert.equal(payload.length, length);
    if (name === "BOOTSTRAP-HOMEOFFICE-IDE-RUNTIME.ps1") {
      const sha = createHash("sha256")
        .update(payload)
        .digest("hex")
        .toUpperCase();
      assert.equal(
        sha,
        "85D862D68C2384949367F85D34C169DE1F09DE2FE09D93EA57810F9D941A3675",
      );
    }
    cursor = start + length;
  }
  assert.deepEqual(observed, expected);
  assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
  const second = spawnSync(process.execPath, [builder, "--out", output], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.notEqual(
    second.status,
    0,
    "a release ZIP must never be silently overwritten",
  );
  assert.deepEqual(fs.readFileSync(output), archive);
});
