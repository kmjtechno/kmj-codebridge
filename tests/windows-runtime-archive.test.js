import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { inspectWindowsRuntimeArchive } from "../src/windows-runtime-archive.js";

const revision = "a".repeat(40);
const root = "kmj-codebridge-0.3.2-" + revision.slice(0, 12);

function member(name, type, data = "") {
  const bytes = Buffer.from(data);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  header.write(bytes.length.toString(8).padStart(11, "0"), 124);
  header[156] = type.charCodeAt(0);
  header.write("ustar", 257);
  header.write("00", 263);
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0"), 148);
  header[154] = 0;
  return Buffer.concat([
    header,
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512),
  ]);
}

function pax(key, value) {
  const row = " " + key + "=" + value + "\n";
  let length = row.length + 1;
  while (String(length).length + row.length !== length) {
    length = String(length).length + row.length;
  }
  return String(length) + row;
}

function fixture(extra = [], globalRevision = revision) {
  const tar = Buffer.concat([
    member("pax_global_header", "g", pax("comment", globalRevision)),
    member(root + "/", "5"),
    member(
      root + "/package.json",
      "0",
      JSON.stringify({ name: "@kmjtechno/codebridge", version: "0.3.2" }),
    ),
    member(root + "/src/", "5"),
    member(root + "/src/cli.js", "0", "console.log('fixture');"),
    ...extra,
    Buffer.alloc(1024),
  ]);
  const archive = gzipSync(tar);
  const manifest = {
    schema: 1,
    product: "KMJ CodeBridge",
    channel: "stable",
    sequence: 43,
    version: "0.3.2",
    revision,
    archive:
      "https://kmjtechno.com/codebridge/releases/stable/" +
      revision +
      "/" +
      root +
      ".tar.gz",
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
    nodeMajor: 24,
    publishedAt: "2026-11-28T07:28:16.932Z",
    keyId: "kmj-release-2026",
  };
  return { archive, manifest };
}

test("verified regular files and directories are admitted without extraction", () => {
  const { archive, manifest } = fixture();
  const result = inspectWindowsRuntimeArchive(archive, manifest);
  assert.equal(result.archiveVerified, true);
  assert.equal(result.activationAttempted, false);
  assert.equal(result.entries.length, 4);
  assert.equal(result.revision, revision);
});

test("reject archive digest mismatch and wrong Git archive provenance", () => {
  const { archive, manifest } = fixture();
  assert.throws(() =>
    inspectWindowsRuntimeArchive(archive, {
      ...manifest,
      sha256: "b".repeat(64),
    }),
  );
  const wrong = fixture([], "b".repeat(40));
  assert.throws(
    () => inspectWindowsRuntimeArchive(wrong.archive, wrong.manifest),
    /WINDOWS_UPDATE_ARCHIVE_REJECTED/,
  );
});

test("reject links, traversal, aliases and case-insensitive collisions", () => {
  for (const entry of [
    member(root + "/link", "2"),
    member(root + "/../escape.js", "0", "x"),
    member(root + "/CON.txt", "0", "x"),
    member(root + "/src/CLI.js", "0", "x"),
    member(root + "/file.js:stream", "0", "x"),
  ]) {
    const { archive, manifest } = fixture([entry]);
    assert.throws(() => inspectWindowsRuntimeArchive(archive, manifest));
  }
});

test("only local PAX path overrides are accepted; size override is refused", () => {
  const longName = root + "/src/" + "b".repeat(120) + ".js";
  const valid = fixture([
    member("pax", "x", pax("path", longName)),
    member("placeholder", "0", "x"),
  ]);
  assert.equal(
    inspectWindowsRuntimeArchive(valid.archive, valid.manifest).entries.at(-1)
      .name,
    longName,
  );
  const bad = fixture([
    member("pax", "x", pax("size", "1000")),
    member("placeholder", "0", "x"),
  ]);
  assert.throws(() => inspectWindowsRuntimeArchive(bad.archive, bad.manifest));
});
